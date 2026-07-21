// ============================================================
//  Remote Browser Bridge — Background Service Worker
//  接收来自 content script (Relay) 的指令，在目标标签页执行
//  只操控 "Remote Control" 标签组内的标签页
//  支持 iframe 内元素操作 + Canvas 渲染文本读取
// ============================================================

const CONTROLLED_GROUP = 'Remote Control';

let relayConnected = false;
let relayBrowserId = null;
let relayBridgeUrl = null;
let relayToken = null;
let lastLog = '';

// MV3 的 service worker 会被随时回收，模块级 globals 会一起丢失。
// 用 chrome.storage.session 持久化连接状态，并在 worker 重启时恢复，
// 否则 SW 重启后定时推送会静默停掉、徽章也会变灰。
async function saveRelayState() {
  try {
    await chrome.storage.session.set({ relayConnected, relayBrowserId, relayBridgeUrl, relayToken });
  } catch (e) {}
}
async function restoreRelayState() {
  try {
    const s = await chrome.storage.session.get(['relayConnected', 'relayBrowserId', 'relayBridgeUrl', 'relayToken']);
    if (s && s.relayBridgeUrl) {
      relayConnected = !!s.relayConnected;
      relayBrowserId = s.relayBrowserId || null;
      relayBridgeUrl = s.relayBridgeUrl || null;
      relayToken = s.relayToken || null;
      if (relayConnected) updateBadge('ON', '#4caf50');
    }
  } catch (e) {}
}
restoreRelayState();

// ─── 当前目标标签（后台友好）───
// 记住"当前正在操控的标签页"，让命令能作用于后台标签而不必把它切到前台。
// 由 switch_tab / set_target / new_tab 设定；持久化到 storage.session 以扛住 SW 回收。
let currentTargetTabId = null;

async function getTargetTabId() {
  if (currentTargetTabId != null) return currentTargetTabId;
  try {
    const s = await chrome.storage.session.get(['currentTargetTabId']);
    if (s && s.currentTargetTabId != null) { currentTargetTabId = s.currentTargetTabId; return currentTargetTabId; }
  } catch (e) {}
  return null;
}
async function setTargetTabId(tabId) {
  currentTargetTabId = tabId;
  try { await chrome.storage.session.set({ currentTargetTabId: tabId }); } catch (e) {}
}
// 目标标签被关闭时清掉记忆，避免指向已消失的标签
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentTargetTabId === tabId) {
    currentTargetTabId = null;
    chrome.storage.session.remove('currentTargetTabId').catch(() => {});
  }
});

// ─── 标签组权限检查 ───
async function getControlledGroupId() {
  try {
    const groups = await chrome.tabGroups.query({ title: CONTROLLED_GROUP });
    return groups.length > 0 ? groups[0].id : null;
  } catch (e) {
    return null;
  }
}

async function checkTabInControlledGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId === -1) return false;
  try {
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title === CONTROLLED_GROUP;
  } catch (e) {
    return false;
  }
}

async function ensureControlledGroup() {
  let groupId = await getControlledGroupId();
  if (groupId) return groupId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const gid = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(gid, { title: CONTROLLED_GROUP, color: 'purple' });
  console.log('[Bridge] 🔒 已创建受控标签组:', CONTROLLED_GROUP);
  return gid;
}

async function addTabToControlledGroup(tabId) {
  let groupId = await getControlledGroupId();
  if (!groupId) groupId = await ensureControlledGroup();
  await chrome.tabs.group({ groupId, tabIds: [tabId] });
}

// 解析出要操控的受控标签页 —— 关键：不再强制把它切到前台。
// 除了 screenshot（captureVisibleTab 的硬限制），其余命令都在后台标签上执行，不抢焦点。
async function getControlledTab() {
  const groupId = await getControlledGroupId();
  if (!groupId) throw new Error(`没有找到 "${CONTROLLED_GROUP}" 标签组。请在 Chrome 中创建一个名为 "${CONTROLLED_GROUP}" 的标签组，或使用 create_group 命令`);
  const tabs = await chrome.tabs.query({ groupId });
  if (tabs.length === 0) throw new Error(`"${CONTROLLED_GROUP}" 标签组为空`);

  // 1) 优先用记忆里的"当前目标标签"（前提是它还在受控组里）
  const savedId = await getTargetTabId();
  if (savedId != null) {
    const saved = tabs.find(t => t.id === savedId);
    if (saved) return saved;
  }
  // 2) 若你此刻前台正看的标签恰好在组里，用它并记住
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && tabs.some(t => t.id === active.id)) {
    await setTargetTabId(active.id);
    return active;
  }
  // 3) 否则退回组里第一个标签，但**不激活它**（后台执行）
  await setTargetTabId(tabs[0].id);
  return tabs[0];
}

// ─── Popup 消息 ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({ connected: relayConnected, browserId: relayBrowserId, log: lastLog });
    return false;
  }
  if (msg.type === 'reconnect') {
    relayConnected = false;
    relayBrowserId = null;
    updateBadge('OFF', '#f44336');
    saveRelayState();
    return false;
  }
  if (msg.type === 'disconnect') {
    relayConnected = false;
    relayBrowserId = null;
    updateBadge('OFF', '#f44336');
    saveRelayState();
    return false;
  }
  if (msg.type === 'relay_log') {
    lastLog = msg.msg;
    notifyPopup({ connected: relayConnected, browserId: relayBrowserId, log: msg.msg });
    return false;
  }
  if (msg.type === 'relay_status') {
    relayConnected = msg.connected;
    relayBrowserId = msg.browserId;
    if (msg.bridgeUrl) relayBridgeUrl = msg.bridgeUrl;
    if (msg.token) relayToken = msg.token;
    saveRelayState();
    if (msg.connected) {
      updateBadge('ON', '#4caf50');
      // 连接成功后立即推送当前页面信息（不切换标签页）
      setTimeout(async () => {
        try {
          const cgid = await getControlledGroupId();
          if (cgid) {
            const tabs = await chrome.tabs.query({ groupId: cgid });
            if (tabs.length > 0) pushPageInfo(tabs[0]);
          }
        } catch (e) {}
      }, 800);
    } else updateBadge('OFF', '#f44336');
    notifyPopup({ connected: msg.connected, browserId: msg.browserId });
    return false;
  }
  if (msg.type === 'execute_command') {
    executeAction(msg.action, msg.params || {})
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ─── 指令执行 ───
async function executeAction(action, params) {
  switch (action) {
    case 'create_group': {
      const gid = await ensureControlledGroup();
      const tabs = await chrome.tabs.query({ groupId: gid });
      return { groupId: gid, title: CONTROLLED_GROUP, tabCount: tabs.length, tabIds: tabs.map(t => t.id) };
    }
    case 'list_controlled_tabs': {
      const groupId = await getControlledGroupId();
      if (!groupId) return { groupId: null, tabs: [], message: `标签组 "${CONTROLLED_GROUP}" 不存在，请使用 create_group 创建` };
      const tabs = await chrome.tabs.query({ groupId });
      return { groupId, title: CONTROLLED_GROUP, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })) };
    }
    case 'add_to_group':
      await addTabToControlledGroup(params.tabId);
      return { added: params.tabId, group: CONTROLLED_GROUP };
    case 'check_group':
      const gid = await getControlledGroupId();
      return { exists: !!gid, groupId: gid, title: CONTROLLED_GROUP };
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      const cgid = await getControlledGroupId();
      const targetId = await getTargetTabId();
      return tabs.map(t => {
        const controlled = t.groupId !== -1 && t.groupId === cgid;
        return { id: t.id, url: t.url, title: t.title, active: t.active, controlled, target: t.id === targetId };
      });
    }
    // 把某个受控标签设为"当前目标"，但不激活它（后台操控用）
    case 'set_target': {
      if (!(await checkTabInControlledGroup(params.tabId)))
        throw new Error(`标签页 ${params.tabId} 不在 "${CONTROLLED_GROUP}" 组中`);
      await setTargetTabId(params.tabId);
      return { target: params.tabId };
    }
    case 'get_target': {
      return { target: await getTargetTabId() };
    }
  }

  // ══════════════════════════════════════
  // 以下命令需要受控标签组权限
  // ══════════════════════════════════════
  const tab = await getControlledTab();
  const frameId = params.frameId;

  switch (action) {
    case 'navigate':
      await chrome.tabs.update(tab.id, { url: params.url });
      await waitForPageLoad(tab.id);
      return { url: params.url, title: (await chrome.tabs.get(tab.id)).title };
    case 'new_tab': {
      // 默认后台打开（active:false），不抢焦点；需要弹到前台时传 params.active:true
      const newTab = await chrome.tabs.create({ url: params.url || 'about:blank', active: params.active === true });
      await waitForPageLoad(newTab.id);
      try { await addTabToControlledGroup(newTab.id); } catch(e) {}
      await setTargetTabId(newTab.id); // 新标签成为后续操作的默认目标
      return { tabId: newTab.id, url: newTab.url, title: newTab.title, inGroup: CONTROLLED_GROUP };
    }
    case 'close_tab': {
      const targetTab = params.tabId || tab.id;
      // 指定 tabId 时必须在受控组内，避免误关用户其它标签页（维持"只碰 Remote Control 组"的安全承诺）
      if (params.tabId && !(await checkTabInControlledGroup(params.tabId)))
        throw new Error(`标签页 ${params.tabId} 不在 "${CONTROLLED_GROUP}" 组中，拒绝关闭`);
      await chrome.tabs.remove(targetTab);
      return { closed: true, tabId: targetTab };
    }
    case 'switch_tab':
      // 显式"切到前台"：既激活也设为目标
      if (!await checkTabInControlledGroup(params.tabId))
        throw new Error(`标签页 ${params.tabId} 不在 "${CONTROLLED_GROUP}" 组中`);
      await chrome.tabs.update(params.tabId, { active: true });
      await setTargetTabId(params.tabId);
      return { switched: params.tabId };

    // ── iframe ──
    case 'list_frames': {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      return frames.map(f => ({
        frameId: f.frameId, parentFrameId: f.parentFrameId,
        url: f.url, isMainFrame: f.frameId === 0
      }));
    }

    // ── Canvas 简历 Hook（注入所有 frame 的 MAIN 世界，才能拦截页面真实的 canvas 绘制）──
    case 'install_resume_hook': {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: installResumeHook
      });
      const frames = results.map(r => r.result).filter(Boolean);
      return {
        installed: frames.filter(r => r.installed).length,
        already: frames.filter(r => r.already).length,
        totalFrames: frames.length,
        frames: frames.map(r => r.frameUrl)
      };
    }

    // ── 读取 Canvas 简历（同步，返回当前可见内容）──
    case 'read_resume_canvas': {
      // 必须与 hook 同在 MAIN 世界，才能读到 window.__bossResumeCanvasTexts
      const result = await executeInTab(tab.id, readResumeCanvasSync, [], frameId, 'MAIN');
      return result;
    }

    // ── 滚动读取完整 Canvas 简历（异步，逐屏滚动收集）──
    case 'read_resume_canvas_full': {
      const maxScrolls = params.maxScrolls || 15;
      const result = await executeInTab(tab.id, readResumeCanvasFull, [maxScrolls], frameId, 'MAIN');
      return result;
    }

    // ── 通用浏览器操控 ──
    // 关闭弹窗/遮罩层
    case 'dismiss_overlays': {
      const result = await executeInTab(tab.id, dismissOverlays, [params.maxAttempts || 12], frameId);
      return result;
    }
    // 扫描页面风控关键词
    case 'check_risk': {
      const result = await executeInTab(tab.id, checkRisk, [], frameId);
      return result;
    }
    // 提取页面所有链接
    case 'get_links': {
      const result = await executeInTab(tab.id, getLinks, [], frameId);
      return result;
    }
    // 滚动到页面底部（支持多次滚动触发懒加载）
    case 'scroll_to_bottom': {
      const maxRounds = params.maxRounds || 5;
      const delay = params.delay || 600;
      const result = await executeInTab(tab.id, scrollToBottom, [maxRounds, delay], frameId);
      return result;
    }
    // 等待文字出现
    case 'wait_for_text': {
      const text = params.text || '';
      const timeout = params.timeout || 10000;
      if (!text) throw new Error('text param required for wait_for_text');
      const result = await executeInTab(tab.id, waitForText, [text, timeout], frameId);
      return result;
    }
    // 按可见文字点击
    case 'click_text': {
      const clickText = params.text || '';
      const tag = params.tag || '';
      if (!clickText) throw new Error('text param required for click_text');
      const result = await executeInTab(tab.id, clickByText, [clickText, tag || null], frameId);
      return result;
    }

    // ── 网络层操作（fetch 劫持 + page-context 代理）──
    case 'network_intercept': {
      // 必须在 MAIN 世界打补丁，否则拦截的是隔离世界的 fetch/XHR，抓不到页面真实流量
      const result = await executeInTab(tab.id, networkIntercept, [], frameId, 'MAIN');
      return result;
    }
    case 'network_requests': {
      const result = await executeInTab(tab.id, networkRequests, [], frameId, 'MAIN');
      return result;
    }
    case 'network_fetch': {
      const url = params.url || '';
      const method = params.method || 'GET';
      const body = params.body || null;
      const headers = params.headers || {};
      if (!url) throw new Error('url param required for network_fetch');
      const result = await executeInTab(tab.id, networkFetch, [url, method, headers, body], frameId, 'MAIN');
      return result;
    }
    case 'network_clear': {
      const result = await executeInTab(tab.id, networkClear, [], frameId, 'MAIN');
      return result;
    }
    // 请求路由（mock/abort，作用于 fetch）
    case 'route_add': {
      await executeInTab(tab.id, networkIntercept, [], frameId, 'MAIN'); // 确保拦截已安装
      return await executeInTab(tab.id, routeAdd, [params.route || {}], frameId, 'MAIN');
    }
    case 'route_clear':
      return await executeInTab(tab.id, routeClear, [], frameId, 'MAIN');
    // 等待网络空闲
    case 'wait_network_idle': {
      await executeInTab(tab.id, networkIntercept, [], frameId, 'MAIN'); // 确保在途计数生效
      return await executeInTab(tab.id, waitNetworkIdle, [params.idleMs || 500, params.timeout || 15000], frameId, 'MAIN');
    }

    // ── DOM 操作（支持可选 frameId）──
    case 'click':
      return await executeInTab(tab.id, clickElement, [params.selector, params.index || 0], frameId);
    case 'type':
      return await executeInTab(tab.id, typeText, [params.selector, params.text, params.clearFirst !== false], frameId);
    case 'press_key':
      return await executeInTab(tab.id, pressKey, [params.selector, params.key], frameId);
    case 'scroll':
      return await executeInTab(tab.id, scrollPage, [params.x || 0, params.y || 300], frameId);
    case 'scroll_into_view':
      return await executeInTab(tab.id, scrollIntoViewFn, [params.selector], frameId);
    case 'screenshot':
    case 'viewport_screenshot': {
      const format = params.format || 'png';
      // captureVisibleTab 只能截"窗口里当前可见的标签"（Chrome 硬限制）。
      // 若目标标签不在前台：临时激活它 → 截图 → 再切回你原来的标签，尽量少打扰。
      const [prevActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      const mustSwitch = !prevActive || prevActive.id !== tab.id;
      try {
        if (mustSwitch) {
          await chrome.tabs.update(tab.id, { active: true });
          await sleep(250); // 等这一帧渲染出来再截
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
        const vp = await executeInTab(tab.id, getViewport, [], frameId);
        return { format, dataUrl, viewport: vp, refocused: mustSwitch };
      } finally {
        // 无论成败，都把焦点还给你原来的标签
        if (mustSwitch && prevActive) {
          try { await chrome.tabs.update(prevActive.id, { active: true }); } catch (e) {}
        }
      }
    }
    case 'snapshot':
      return await executeInTab(tab.id, getPageSnapshot, [params.maxLength || 8000], frameId);

    // ── 结构化「无障碍」快照 + 按 ref 操作（给 LLM/Agent 用，比 CSS 选择器稳）──
    // snapshot_refs 给页面上每个可交互元素编号 [e1] [e2]…，并把映射存到页面隔离世界的
    // window.__bridgeRefs，随后 click_ref / type_ref / get_ref 直接按 ref 操作，无需选择器。
    case 'snapshot_refs':
    case 'aria_snapshot':
      return await executeInTab(tab.id, buildRefSnapshot, [params.maxNodes || 200], frameId);
    case 'click_ref':
      if (!params.ref) throw new Error('ref param required for click_ref');
      return await executeInTab(tab.id, clickRef, [params.ref], frameId);
    case 'type_ref':
      if (!params.ref) throw new Error('ref param required for type_ref');
      return await executeInTab(tab.id, typeRef, [params.ref, params.text || '', params.clearFirst !== false], frameId);
    case 'get_ref':
      if (!params.ref) throw new Error('ref param required for get_ref');
      return await executeInTab(tab.id, getRefInfo, [params.ref], frameId);

    // 定位器 + 自动等待 + 执行（Playwright 式）——见 locatorAct
    case 'locator_act':
      if (!params.op) throw new Error('op param required for locator_act');
      return await executeInTab(tab.id, locatorAct, [params.spec || {}, params.op, params.args || {}, params.opts || {}], frameId);

    case 'get_text':
      return await executeInTab(tab.id, getElementText, [params.selector], frameId);
    case 'get_attribute':
      return await executeInTab(tab.id, getAttribute, [params.selector, params.attribute], frameId);
    case 'get_html':
      return await executeInTab(tab.id, getHtml, [params.selector || 'body', params.maxLength || 10000], frameId);
    case 'evaluate':
      return await executeInTab(tab.id, evalCode, [params.code], frameId);
    case 'wait_for':
      return await executeInTab(tab.id, waitForElement, [params.selector, params.timeout || 10000], frameId);
    case 'sleep':
      await sleep(params.ms || 1000);
      return { slept: params.ms || 1000 };
    case 'get_page_info': {
      const info = await chrome.tabs.get(tab.id);
      const vp = await executeInTab(tab.id, getViewport, [], frameId);
      const inGroup = await checkTabInControlledGroup(tab.id);
      let cookies = [];
      try { cookies = await chrome.cookies.getAll({ url: info.url }); } catch (e) {}
      return {
        url: info.url, title: info.title, tabId: tab.id, viewport: vp,
        controlled: inGroup, favIconUrl: info.favIconUrl || '',
        cookieCount: cookies.length,
        // 默认只回传数量，需要值时显式传 includeCookies: true（减少无意间泄露会话 cookie）
        cookies: (params.includeCookies === true) ? cookies.map(c => ({
          name: c.name, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          value: c.value ? c.value.substring(0, 200) : ''
        })) : []
      };
    }
    case 'get_cookies': {
      const info = await chrome.tabs.get(tab.id);
      const url = params.url || info.url;
      let cookies = [];
      try { cookies = await chrome.cookies.getAll({ url }); } catch (e) {}
      if (params.domain) {
        try { cookies = await chrome.cookies.getAll({ domain: params.domain }); } catch (e) {}
      }
      return {
        url,
        total: cookies.length,
        cookies: cookies.map(c => ({
          name: c.name, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          value: c.value ? c.value.substring(0, 500) : ''
        }))
      };
    }
    case 'go_back':
      await chrome.tabs.goBack(tab.id);
      await sleep(500);
      return { url: (await chrome.tabs.get(tab.id)).url };
    case 'go_forward':
      await chrome.tabs.goForward(tab.id);
      await sleep(500);
      return { url: (await chrome.tabs.get(tab.id)).url };
    case 'reload':
      await chrome.tabs.reload(tab.id);
      await waitForPageLoad(tab.id);
      return { url: (await chrome.tabs.get(tab.id)).url };
    case 'select':
      return await executeInTab(tab.id, selectOption, [params.selector, params.value], frameId);
    default:
      throw new Error(`未知动作: ${action}`);
  }
}

// ─── 工具函数 ───
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab;
}
function waitForPageLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { chrome.tabs.onUpdated.removeListener(l); } catch (e) {}
      resolve();
    };
    const l = (tid, info) => { if (tid === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(l);
    const t = setTimeout(finish, timeout);
    // 兜底：缓存命中 / 同文档跳转可能不会再触发 complete 事件，800ms 后主动查一次状态，
    // 避免这类页面白等满 timeout
    setTimeout(async () => {
      try { const tb = await chrome.tabs.get(tabId); if (tb.status === 'complete') finish(); } catch (e) {}
    }, 800);
  });
}
async function executeInTab(tabId, fn, args, frameId, world) {
  const target = { tabId };
  if (frameId !== undefined) target.frameIds = [frameId];
  const injection = { target, func: fn, args };
  // world: 'MAIN' 让脚本运行在页面真实执行环境里（能拦截页面的 fetch/XHR、canvas 绘制、读取页面变量）
  if (world) injection.world = world;
  let results;
  try {
    results = await chrome.scripting.executeScript(injection);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/cannot be scripted|Cannot access|chrome:\/\/|extension gallery|showing error page|The extensions gallery/i.test(msg)) {
      throw new Error(`该页面不允许脚本注入（chrome://、Web Store、或受限页面）: ${msg}`);
    }
    throw e;
  }
  return results[0]?.result;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
function notifyPopup(data) {
  chrome.runtime.sendMessage({ type: 'connection_status', ...data }).catch(() => {});
}

// ─── DOM 操作函数 ───
function clickElement(selector, index) {
  const els = document.querySelectorAll(selector);
  const el = els[index] || els[0];
  if (!el) return { clicked: false, found: 0, error: `not found: ${selector}` };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  // 只点一次：避免复选框/单选被切换两次（等于没变），见 clickRef 注释
  try { el.click(); } catch(e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
  return { clicked: true, tag: el.tagName, text: el.textContent?.substring(0, 100) };
}
function typeText(selector, text, clearFirst) {
  const el = document.querySelector(selector);
  if (!el) return { typed: false, error: `not found: ${selector}` };
  el.focus();

  // contenteditable：el.value 无效，需操作文本内容
  if (el.isContentEditable) {
    if (clearFirst) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    }
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { typed: true, tag: el.tagName, contentEditable: true };
  }

  // input / textarea：用原生 value setter，让 React/Vue 的受控组件也能感知到变化
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value') &&
                       Object.getOwnPropertyDescriptor(proto, 'value').set;
  const setValue = (v) => { nativeSetter ? nativeSetter.call(el, v) : (el.value = v); };

  const next = (clearFirst ? '' : (el.value || '')) + text;
  setValue(next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, tag: el.tagName };
}
function pressKey(selector, key) {
  const el = selector ? document.querySelector(selector) : document.activeElement;
  if (!el) return { pressed: false, error: 'no target element' };
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  return { pressed: true, key };
}
function scrollPage(x, y) {
  window.scrollBy(x, y);
  return { to: { x: window.scrollX, y: window.scrollY } };
}
function scrollIntoViewFn(selector) {
  const el = document.querySelector(selector);
  if (!el) return { scrolled: false };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  return { scrolled: true };
}
function getViewport() {
  return { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, totalHeight: document.documentElement.scrollHeight, totalWidth: document.documentElement.scrollWidth };
}
function getPageSnapshot(maxLength) {
  const body = document.body;
  if (!body) return '';
  let text = body.innerText || '';
  if (text.length > maxLength) text = text.substring(0, maxLength) + '\n...(truncated)';
  return text;
}
function getElementText(selector) {
  const els = document.querySelectorAll(selector);
  return Array.from(els).map(el => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 500), visible: el.offsetParent !== null }));
}
function getAttribute(selector, attr) {
  const els = document.querySelectorAll(selector);
  return Array.from(els).map(el => ({ tag: el.tagName, value: el.getAttribute(attr) || el[attr] || null }));
}
function getHtml(selector, maxLength) {
  const el = document.querySelector(selector);
  if (!el) return null;
  let html = el.outerHTML;
  if (html.length > maxLength) html = html.substring(0, maxLength) + '\n<!-- truncated -->';
  return html;
}
function evalCode(code) {
  // 注：运行在隔离世界（不受页面 CSP 影响，但读不到页面自身的 JS 变量）。
  // 若返回对象，尽量保留结构而不是被 String() 压平成 "[object Object]"。
  try {
    const value = eval(code);
    let result;
    try { result = JSON.parse(JSON.stringify(value)); }
    catch (e) { result = String(value); }
    return { result, type: typeof value };
  } catch (e) { return { error: e.message }; }
}
function waitForElement(selector, timeout) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) { resolve({ found: true, tag: el.tagName }); return; }
    const o = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { o.disconnect(); clearTimeout(t); resolve({ found: true, tag: el.tagName }); }
    });
    o.observe(document.body || document.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => { o.disconnect(); resolve({ found: false, error: `timeout ${timeout}ms: ${selector}` }); }, timeout);
  });
}
function selectOption(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { selected: false };
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: true, value };
}

// ══════════════════════════════════════
// 结构化「无障碍」快照 + 按 ref 操作
// 供 LLM/Agent 使用：给每个可交互/结构性元素编号，按 ref 操作而非脆弱的 CSS 选择器
// ══════════════════════════════════════

function buildRefSnapshot(maxNodes) {
  const LIMIT = maxNodes || 200;
  const store = (window.__bridgeRefs = {}); // 存到隔离世界的 window，供后续 click_ref/type_ref 解析
  let n = 0;
  const out = [];

  // display:none / visibility:hidden → 整个子树跳过（不递归）
  const isHidden = (el) => {
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  };
  // 元素自身是否有可见盒子（用于决定是否收录，不用于是否递归）
  const hasBox = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return tag;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const l = document.getElementById(labelledby);
      if (l) return (l.innerText || l.textContent || '').replace(/\s+/g, ' ').trim();
    }
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (lab) return (lab.innerText || lab.textContent || '').replace(/\s+/g, ' ').trim();
      } catch (e) {}
    }
    const wrapLabel = el.closest && el.closest('label');
    if (wrapLabel) { const t = (wrapLabel.innerText || '').replace(/\s+/g, ' ').trim(); if (t) return t; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    }
    if (tag === 'img') return el.getAttribute('alt') || '';
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    return el.getAttribute('title') || el.getAttribute('name') || '';
  };

  const isInteractive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'switch', 'option'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.getAttribute('tabindex') !== null && el.tabIndex >= 0) return true;
    return false;
  };
  const isHeading = (el) => /^h[1-6]$/.test(el.tagName.toLowerCase());

  const walk = (el) => {
    if (n >= LIMIT) return;
    if (isHidden(el)) return; // 隐藏子树整体跳过
    if ((isInteractive(el) || isHeading(el)) && hasBox(el)) {
      const ref = 'e' + (++n);
      store[ref] = el;
      const item = { ref, role: roleOf(el), name: nameOf(el).substring(0, 120) };
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.getAttribute('href')) item.href = el.href;
      if (tag === 'input' || tag === 'textarea') {
        const type = el.getAttribute('type'); if (type) item.type = type;
        if (el.placeholder) item.placeholder = el.placeholder;
        if (el.value) item.value = String(el.value).substring(0, 80);
        if ((el.type === 'checkbox' || el.type === 'radio')) item.checked = !!el.checked;
      }
      if (el.disabled) item.disabled = true;
      out.push(item);
    }
    const kids = el.children;
    for (let i = 0; i < kids.length && n < LIMIT; i++) walk(kids[i]);
    // 穿透开放 Shadow DOM
    if (el.shadowRoot) {
      const sk = el.shadowRoot.children;
      for (let i = 0; i < sk.length && n < LIMIT; i++) walk(sk[i]);
    }
  };
  walk(document.body || document.documentElement);

  const text = out.map((it) => {
    let line = '[' + it.ref + '] ' + it.role;
    if (it.name) line += ' "' + it.name + '"';
    if (it.href) line += ' (' + it.href + ')';
    if (it.placeholder) line += ' placeholder="' + it.placeholder + '"';
    if (it.value) line += ' value="' + it.value + '"';
    if (it.checked) line += ' [checked]';
    if (it.disabled) line += ' [disabled]';
    return line;
  }).join('\n');

  return { url: location.href, title: document.title, count: out.length, truncated: n >= LIMIT, elements: out, text };
}

function clickRef(ref) {
  const el = (window.__bridgeRefs || {})[ref];
  if (!el) return { clicked: false, error: 'ref 未找到（页面可能已变化，请重新 snapshot_refs）: ' + ref };
  if (!document.contains(el)) return { clicked: false, error: 'ref 对应元素已从页面移除，请重新 snapshot_refs: ' + ref };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  // 只触发一次点击：el.click() 会派发可冒泡的 click 并执行默认行为（勾选复选框/跟随链接/提交等），
  // React/Vue 也能在根部捕获。切忌再额外 dispatch 一个 click —— 否则复选框会被切换两次（等于没变）。
  try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
  return { clicked: true, ref, tag: el.tagName, text: (el.innerText || el.value || '').substring(0, 80) };
}

function typeRef(ref, text, clearFirst) {
  const el = (window.__bridgeRefs || {})[ref];
  if (!el) return { typed: false, error: 'ref 未找到（请重新 snapshot_refs）: ' + ref };
  if (!document.contains(el)) return { typed: false, error: 'ref 对应元素已移除: ' + ref };
  el.focus();
  if (el.isContentEditable) {
    if (clearFirst) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('delete');
    }
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { typed: true, ref, contentEditable: true };
  }
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const setValue = (v) => { (desc && desc.set) ? desc.set.call(el, v) : (el.value = v); };
  setValue((clearFirst ? '' : (el.value || '')) + text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, ref, tag: el.tagName };
}

function getRefInfo(ref) {
  const el = (window.__bridgeRefs || {})[ref];
  if (!el) return { error: 'ref 未找到（请重新 snapshot_refs）: ' + ref };
  const rect = el.getBoundingClientRect();
  return {
    ref, tag: el.tagName, role: el.getAttribute('role') || null,
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 200),
    value: (el.value !== undefined) ? el.value : null,
    href: el.href || null,
    visible: el.offsetParent !== null,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  };
}

// ══════════════════════════════════════
// 定位器 + 自动等待 + 执行（对齐 Playwright 的 locator/actionability）
//   spec: { css | ref | role+name | text | testid | label | placeholder, within, nth, hasText, exact }
//   op:   click/dblclick/hover/fill/type/check/uncheck/selectOption/press/
//         waitFor/getText/getValue/getAttribute/isVisible/count/scrollIntoView
//   在超时前反复：解析定位器 → 检查可操作性(存在+可见+可用) → 执行；否则报最后失败原因。
//   支持穿透开放 Shadow DOM。
// ══════════════════════════════════════
async function locatorAct(spec, op, args, opts) {
  spec = spec || {}; args = args || {}; opts = opts || {};
  const timeout = opts.timeout || 15000;
  const deadline = Date.now() + timeout;

  const deepEls = (root, acc) => {
    acc = acc || [];
    const list = root.querySelectorAll('*');
    for (let i = 0; i < list.length; i++) { const el = list[i]; acc.push(el); if (el.shadowRoot) deepEls(el.shadowRoot, acc); }
    return acc;
  };
  const deepQueryAll = (sel) => {
    const out = [];
    try { document.querySelectorAll(sel).forEach(e => out.push(e)); } catch (e) { return out; }
    for (const el of deepEls(document)) if (el.shadowRoot) { try { el.shadowRoot.querySelectorAll(sel).forEach(e => out.push(e)); } catch (e) {} }
    return Array.from(new Set(out));
  };
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const attr = (el, n) => (el.getAttribute ? el.getAttribute(n) : null);
  const roleOf = (el) => {
    const e = attr(el, 'role'); if (e) return e;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') { const t = (attr(el, 'type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox'; return 'textbox'; }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return tag;
  };
  const nameOf = (el) => {
    const a = attr(el, 'aria-label'); if (a) return a.trim();
    if (el.id) { try { const lab = document.querySelector('label[for="' + ((window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id) + '"]'); if (lab) return txt(lab); } catch (e) {} }
    const wl = el.closest && el.closest('label'); if (wl) { const t = txt(wl); if (t) return t; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return attr(el, 'placeholder') || attr(el, 'name') || '';
    return txt(el) || attr(el, 'title') || '';
  };
  const matchStr = (val, want, exact) => { if (want == null) return true; val = (val || '').trim(); return exact ? val === want : val.indexOf(want) !== -1; };
  const visReason = (el) => {
    if (!el || !el.isConnected) return 'detached';
    const s = getComputedStyle(el);
    if (s.display === 'none') return 'display:none';
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'visibility:hidden';
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return 'zero-size';
    return null;
  };
  const actReason = (el) => {
    const v = visReason(el); if (v) return v;
    if (el.disabled) return 'disabled';
    if (attr(el, 'aria-disabled') === 'true') return 'aria-disabled';
    return null;
  };
  const interactiveish = (el) => {
    const tag = el.tagName.toLowerCase();
    return ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
      ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch'].includes(attr(el, 'role')) ||
      el.hasAttribute('onclick') || el.isContentEditable;
  };
  const hasCriteria = spec.css || spec.ref || spec.role || spec.name != null || spec.text != null || spec.testid || spec.label != null || spec.placeholder != null;

  const resolveAll = () => {
    if (!hasCriteria) return [];
    let base;
    if (spec.ref) { const e = (window.__bridgeRefs || {})[spec.ref]; base = e ? [e] : []; }
    else if (spec.css) base = deepQueryAll(spec.css);
    else base = deepEls(document);
    if (spec.within) { let c = null; try { c = document.querySelector(spec.within); } catch (e) {} base = c ? base.filter(el => c.contains(el)) : []; }
    const semantic = spec.role || spec.name != null || spec.text != null || spec.testid || spec.label != null || spec.placeholder != null;
    let out = base.filter((el) => {
      if (!el || el.nodeType !== 1) return false;
      if (spec.role && roleOf(el) !== spec.role) return false;
      if (spec.name != null && !matchStr(nameOf(el), spec.name, spec.exact)) return false;
      if (spec.text != null && !matchStr(txt(el), spec.text, spec.exact)) return false;
      if (spec.testid && !(attr(el, 'data-testid') === spec.testid || attr(el, 'data-test') === spec.testid || attr(el, 'data-cy') === spec.testid)) return false;
      if (spec.placeholder != null && !matchStr(attr(el, 'placeholder'), spec.placeholder, spec.exact)) return false;
      if (spec.label != null) {
        const tag = el.tagName.toLowerCase();
        if (!(tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable)) return false;
        if (!matchStr(nameOf(el), spec.label, spec.exact)) return false;
      }
      return true;
    });
    out = Array.from(new Set(out));
    if (semantic) out.sort((a, b) => {
      const va = visReason(a) ? 1 : 0, vb = visReason(b) ? 1 : 0; if (va !== vb) return va - vb; // 可见优先
      if (spec.text != null) { const ia = interactiveish(a) ? 0 : 1, ib = interactiveish(b) ? 0 : 1; if (ia !== ib) return ia - ib; return txt(a).length - txt(b).length; }
      return 0;
    });
    if (spec.hasText != null) out = out.filter(el => txt(el).indexOf(spec.hasText) !== -1);
    return out;
  };
  const pick = (els) => { if (!els.length) return null; let n = (spec.nth != null) ? spec.nth : 0; if (n < 0) n = els.length + n; return els[n] || null; };

  if (!hasCriteria) return { error: '空定位器：至少提供 css/ref/role/text/testid/label/placeholder 之一' };
  if (op === 'count') return { count: resolveAll().length };
  if (op === 'isVisible') { const el = pick(resolveAll()); return { visible: !!el && !visReason(el) }; }

  const nativeSet = (el, v) => { const p = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(p, 'value'); (d && d.set) ? d.set.call(el, v) : (el.value = v); };
  const fillEl = (el, text, clear) => {
    el.focus();
    if (el.isContentEditable) {
      if (clear) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('delete'); }
      document.execCommand('insertText', false, text); el.dispatchEvent(new Event('input', { bubbles: true })); return;
    }
    nativeSet(el, (clear ? '' : (el.value || '')) + text);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const doAction = (el) => {
    switch (op) {
      case 'click': try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } return { ok: true, op, tag: el.tagName, text: txt(el).slice(0, 80) };
      case 'dblclick': el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return { ok: true, op };
      case 'hover': ['pointerover', 'mouseover', 'mouseenter', 'mousemove'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: t !== 'mouseenter', cancelable: true }))); return { ok: true, op };
      case 'fill': fillEl(el, args.text || '', true); return { ok: true, op, tag: el.tagName };
      case 'type': fillEl(el, args.text || '', false); return { ok: true, op, tag: el.tagName };
      case 'check': if (!el.checked) el.click(); return { ok: true, op, checked: !!el.checked };
      case 'uncheck': if (el.checked) el.click(); return { ok: true, op, checked: !!el.checked };
      case 'selectOption': el.value = args.value; el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, op, value: el.value };
      case 'press': el.focus(); ['keydown', 'keypress', 'keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, { key: args.key, bubbles: true }))); return { ok: true, op, key: args.key };
      case 'getText': return { text: txt(el) };
      case 'getValue': return { value: (el.value !== undefined) ? el.value : null };
      case 'getAttribute': return { value: attr(el, args.name) };
      case 'scrollIntoView': el.scrollIntoView({ block: 'center' }); return { ok: true };
      default: return { error: 'unknown op: ' + op };
    }
  };
  const readOnly = (op === 'getText' || op === 'getValue' || op === 'getAttribute');

  const assertConds = { expectText: 1, expectContainText: 1, expectValue: 1, expectChecked: 1 };
  let lastReason = 'not found';
  while (Date.now() < deadline) {
    const el = pick(resolveAll());
    if (op === 'waitFor' || op === 'expectVisible' || op === 'expectHidden') {
      const state = op === 'expectVisible' ? 'visible' : op === 'expectHidden' ? 'hidden' : (args.state || 'visible');
      if (state === 'attached') { if (el) return { ok: true, state }; lastReason = 'not attached'; }
      else if (state === 'detached') { if (!el) return { ok: true, state }; lastReason = 'still attached'; }
      else if (state === 'hidden') { if (!el || visReason(el)) return { ok: true, state }; lastReason = 'still visible'; }
      else { if (el && !visReason(el)) return { ok: true, state }; lastReason = el ? visReason(el) : 'not found'; }
    } else if (assertConds[op]) {
      if (el) {
        let ok = false, cur;
        if (op === 'expectText') { cur = txt(el); ok = cur === String(args.text == null ? '' : args.text).trim(); }
        else if (op === 'expectContainText') { cur = txt(el); ok = cur.indexOf(args.text) !== -1; }
        else if (op === 'expectValue') { cur = (el.value != null ? el.value : ''); ok = cur === String(args.value == null ? '' : args.value); }
        else if (op === 'expectChecked') { cur = !!el.checked; ok = cur === (args.checked !== false); }
        if (ok) return { ok: true, actual: cur };
        lastReason = 'got: ' + JSON.stringify(cur);
      } else lastReason = 'not found';
    } else if (el) {
      const reason = readOnly ? null : actReason(el);
      if (!reason) { if (!readOnly) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} } return doAction(el); }
      lastReason = reason;
    } else { lastReason = 'not found'; }
    await new Promise(r => setTimeout(r, 100));
  }
  return { error: `断言/等待超时 (${timeout}ms) op=${op} locator=${JSON.stringify(spec)} — 最后状态: ${lastReason}` };
}

// ══════════════════════════════════════
// 通用浏览器操控函数
// ══════════════════════════════════════

// 关闭弹窗/遮罩 — 查找关闭按钮 + 按 Escape，轮询直到弹窗消失
async function dismissOverlays(maxAttempts) {
  const limit = maxAttempts || 12;
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
           (rect.width > 0 && rect.height > 0) && el.offsetParent !== null;
  };
  const findAllCloseButtons = () => Array.from(document.querySelectorAll(
    '.dialog-wrap .close-btn, .dialog-wrap .boss-popup__close, .dialog-wrap [class*="close"], ' +
    '.modal .close, .modal [class*="close"], ' +
    '.overlay .close, .overlay [class*="close"], ' +
    '[class*="dialog"] [class*="close"], [aria-label*="关闭"], [aria-label*="close"], ' +
    '[role="dialog"] [class*="close"], .cookie-banner [class*="accept"], .cookie-banner [class*="同意"], ' +
    '.ui-popup__close, .popup__close, .popover__close'
  )).filter(isVisible);
  let anyDismissed = false;
  let attempt = 0;
  while (attempt < limit) {
    const closeBtns = findAllCloseButtons();
    if (closeBtns.length > 0) {
      for (const btn of closeBtns) {
        try { btn.click(); } catch (e) {}
      }
      anyDismissed = true;
    } else if (attempt === 0) {
      // 第一轮没找到关闭按钮就退出，后面轮次只是等动画结束
      if (!anyDismissed) break;
    }
    // 按 Escape
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (e) {}
    attempt++;
    await new Promise(r => setTimeout(r, 150));
  }
  return { dismissed: anyDismissed, attempts: attempt };
}

// 扫描页面风控关键词（验证码 / 限流 / 异常）
function checkRisk() {
  const riskMarkers = [
    '安全验证', '请完成验证', '操作频繁', '访问异常', '账号异常',
    '拖动滑块', '滑块验证', '拼图验证', '点击验证', '图形验证',
    '请稍后再试', '验证身份', '人机验证', '行为验证',
    '频繁操作', '操作过快', '休息一下', 'IP已被限制',
    'risk_prompt', 'security_check', 'captcha', 'verification',
    'Too Many Requests', 'rate limit', 'Access Denied'
  ];
  const bodyText = (document.body && document.body.innerText || '').toLowerCase();
  const titleText = (document.title || '').toLowerCase();
  const haystack = bodyText + '\n' + titleText;
  const hits = riskMarkers.filter(m => haystack.includes(m.toLowerCase()));
  // 检查是否有验证码常见 DOM 结构
  const hasCaptchaDOM = document.querySelectorAll(
    '.geetest_captcha, .captcha, [id*="captcha"], [class*="captcha"], ' +
    '[id*="verify"], [class*="verify"], .yidun, .nocaptcha, #nc_1_n1z, ' +
    '.sm-popup, .risk-popup, [class*="security"]'
  ).length > 0;
  return {
    risky: hits.length > 0 || hasCaptchaDOM,
    markers: hits,
    hasCaptchaDOM,
    bodyTextPreview: bodyText.substring(0, 500)
  };
}

// 提取页面所有链接
function getLinks() {
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => {
    const href = a.href || a.getAttribute('href') || '';
    const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 200);
    if (!href || href.startsWith('javascript:') || href === '#') return null;
    return { text, href, visible: a.offsetParent !== null };
  }).filter(Boolean);
  // 去重
  const seen = new Set();
  const unique = [];
  for (const link of links) {
    const key = link.href + '|' + link.text;
    if (!seen.has(key)) { seen.add(key); unique.push(link); }
  }
  return { total: unique.length, links: unique.slice(0, 200) };
}

// 滚动到页面底部（多次滚动以触发懒加载）
async function scrollToBottom(maxRounds, delay) {
  const limit = maxRounds || 5;
  const wait = delay || 600;
  const getHeights = () => ({
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight
  });
  let prev = getHeights();
  for (let i = 0; i < limit; i++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, wait));
    const curr = getHeights();
    // 如果高度不再变化，说明已经到底
    if (curr.scrollHeight === prev.scrollHeight && curr.scrollY === prev.scrollY && i > 0) {
      return { atBottom: true, rounds: i + 1, ...curr };
    }
    prev = curr;
  }
  return { atBottom: prev.scrollY + prev.clientHeight >= prev.scrollHeight - 50, rounds: limit, ...prev };
}

// 等待特定文字出现（支持正则）
function waitForText(text, timeout) {
  const needle = String(text || '');
  const deadline = Date.now() + (timeout || 10000);
  return new Promise((resolve) => {
    const check = () => {
      const bodyText = document.body && document.body.innerText || '';
      const found = bodyText.includes(needle);
      if (found) {
        resolve({ found: true, text: needle, waited: Date.now() - (deadline - timeout) });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ found: false, text: needle, bodyPreview: bodyText.substring(0, 300) });
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

// 按可见文字点击元素
function clickByText(text, tagName) {
  const tag = (tagName || '').toUpperCase();
  const candidates = [];
  const allEls = tag
    ? document.querySelectorAll(tag.toLowerCase())
    : document.querySelectorAll('button, a, span, div, li, td, label, [role="button"]');
  for (const el of allEls) {
    if (el.offsetParent === null) continue;
    const elText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (elText === text || elText.includes(text)) {
      candidates.push({ el, text: elText.substring(0, 100), exact: elText === text });
    }
  }
  if (candidates.length === 0) {
    return { clicked: false, found: 0, error: `no visible element with text "${text}"` };
  }
  // 优先精确匹配
  candidates.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  const best = candidates[0];
  try {
    best.el.scrollIntoView({ behavior: 'instant', block: 'center' });
    // 只点一次（见 clickRef 注释），避免复选框类被双切换
    try { best.el.click(); } catch (e) { best.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
  } catch (e) {}
  return {
    clicked: true,
    tag: best.el.tagName,
    text: best.text,
    exact: best.exact,
    candidates: candidates.length
  };
}

// ══════════════════════════════════════
// 网络层操作 — fetch 劫持 + page-context 请求代理
// ══════════════════════════════════════

// 注入 fetch/XHR monkey-patch，开始捕获所有请求
function networkIntercept() {
  // 路由与在途计数即使已安装也要保证存在（供 route/waitNetworkIdle 使用）
  if (!window.__bridgeNetRoutes) window.__bridgeNetRoutes = [];
  if (typeof window.__bridgeNetInflight !== 'number') window.__bridgeNetInflight = 0;
  if (window.__bridgeNetworkInterceptActive) return { ok: true, already: true, captured: (window.__bridgeNetworkCaptured || []).length };
  window.__bridgeNetworkCaptured = [];
  window.__bridgeNetworkInterceptActive = true;

  const matchRoute = (url, method) => {
    const routes = window.__bridgeNetRoutes || [];
    for (const r of routes) {
      if (r.method && r.method.toUpperCase() !== method.toUpperCase()) continue;
      let hit = false;
      if (r.isRegex) { try { hit = new RegExp(r.pat).test(url); } catch (e) { hit = false; } }
      else hit = url.indexOf(r.pat) !== -1;
      if (hit) return r;
    }
    return null;
  };

  // Monkey-patch fetch（支持 abort / fulfill 路由 + 在途计数）
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input.url || input.href || '');
    const method = (init && init.method) || 'GET';
    const reqHeaders = (init && init.headers) || {};
    const reqBody = (init && init.body) || null;

    const route = matchRoute(url, method);
    if (route) {
      if (route.kind === 'abort') {
        window.__bridgeNetworkCaptured.push({ url, method, aborted: true, at: Date.now() });
        return Promise.reject(new TypeError('Failed to fetch (bridge route abort)'));
      }
      if (route.kind === 'fulfill') {
        const status = route.status || 200;
        const headers = { 'content-type': route.contentType || 'application/json' };
        window.__bridgeNetworkCaptured.push({ url, method, status, mocked: true, at: Date.now() });
        return Promise.resolve(new Response(route.body != null ? route.body : '', { status, headers }));
      }
    }

    window.__bridgeNetInflight++;
    const start = Date.now();
    return origFetch.apply(this, arguments).then(async (res) => {
      window.__bridgeNetInflight = Math.max(0, window.__bridgeNetInflight - 1);
      const clone = res.clone();
      let respBody = null;
      try {
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
          respBody = await clone.text();
          if (respBody && respBody.length > 50000) respBody = respBody.substring(0, 50000) + '...(truncated)';
        }
      } catch (e) {}
      window.__bridgeNetworkCaptured.push({
        url, method, status: res.status, duration: Date.now() - start,
        reqHeaders: JSON.stringify(reqHeaders).substring(0, 2000),
        reqBody: reqBody ? String(reqBody).substring(0, 5000) : null,
        respBody, at: Date.now()
      });
      return res;
    }).catch(err => {
      window.__bridgeNetInflight = Math.max(0, window.__bridgeNetInflight - 1);
      window.__bridgeNetworkCaptured.push({ url, method, error: err.message, at: Date.now() });
      throw err;
    });
  };

  // Monkey-patch XMLHttpRequest（捕获 + 在途计数；不做路由）
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    const origSend = xhr.send;
    let _url = '', _method = 'GET', _body = null;
    xhr.open = function (method, url) {
      _method = method; _url = url;
      return origOpen.apply(this, arguments);
    };
    xhr.send = function (body) {
      _body = body;
      const start = Date.now();
      window.__bridgeNetInflight++;
      xhr.addEventListener('loadend', () => {
        window.__bridgeNetInflight = Math.max(0, window.__bridgeNetInflight - 1);
        let respBody = null;
        try {
          const ct = xhr.getResponseHeader('content-type') || '';
          if (ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
            respBody = xhr.responseText;
            if (respBody && respBody.length > 50000) respBody = respBody.substring(0, 50000) + '...(truncated)';
          }
        } catch (e) {}
        window.__bridgeNetworkCaptured.push({
          url: _url, method: _method, status: xhr.status, duration: Date.now() - start,
          reqBody: _body ? String(_body).substring(0, 5000) : null,
          respBody, at: Date.now()
        });
      });
      return origSend.apply(this, arguments);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;

  return { ok: true, installed: true };
}

// 增加一条 fetch 路由（match → abort | fulfill 自定义响应）。需先/同时安装拦截。
function routeAdd(route) {
  if (!window.__bridgeNetRoutes) window.__bridgeNetRoutes = [];
  window.__bridgeNetRoutes.push(route || {});
  return { ok: true, routes: window.__bridgeNetRoutes.length };
}
// 清空所有路由
function routeClear() {
  const n = (window.__bridgeNetRoutes || []).length;
  window.__bridgeNetRoutes = [];
  return { cleared: n };
}
// 等待网络空闲：连续 idleMs 内在途请求为 0
async function waitNetworkIdle(idleMs, timeout) {
  idleMs = idleMs || 500; timeout = timeout || 15000;
  const deadline = Date.now() + timeout;
  let idleSince = null;
  while (Date.now() < deadline) {
    const n = window.__bridgeNetInflight || 0;
    if (n === 0) {
      if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleMs) return { idle: true };
    } else { idleSince = null; }
    await new Promise(r => setTimeout(r, 100));
  }
  return { idle: false, inflight: window.__bridgeNetInflight || 0 };
}

// 返回已捕获的请求列表
function networkRequests() {
  const captured = window.__bridgeNetworkCaptured || [];
  return {
    total: captured.length,
    active: !!window.__bridgeNetworkInterceptActive,
    requests: captured.slice(-100).map(r => ({
      url: r.url, method: r.method, status: r.status,
      duration: r.duration, error: r.error,
      reqBody: r.reqBody, respBody: r.respBody,
      at: r.at
    }))
  };
}

// 从页面上下文发请求（自带 cookie/auth），返回原始响应
async function networkFetch(url, method, headers, body) {
  const options = { method: method || 'GET', credentials: 'include' };
  if (headers && Object.keys(headers).length > 0) {
    options.headers = headers;
  }
  if (body) {
    if (typeof body === 'string') {
      options.body = body;
    } else {
      options.body = JSON.stringify(body);
      if (!options.headers) options.headers = {};
      if (!options.headers['Content-Type']) options.headers['Content-Type'] = 'application/json';
    }
  }
  const start = Date.now();
  const res = await fetch(url, options);
  const ct = res.headers.get('content-type') || '';
  let respBody = null;
  if (ct.includes('json')) {
    try {
      respBody = await res.json();
    } catch (e) {
      respBody = await res.text();
    }
  } else if (ct.includes('text') || ct.includes('javascript')) {
    respBody = await res.text();
    if (respBody && respBody.length > 100000) respBody = respBody.substring(0, 100000) + '...(truncated)';
  } else {
    const blob = await res.blob();
    respBody = `[binary: ${blob.type}, ${blob.size} bytes]`;
  }
  return {
    ok: res.ok, status: res.status, duration: Date.now() - start,
    contentType: ct, body: respBody
  };
}

// 清空已捕获的请求列表
function networkClear() {
  const count = (window.__bridgeNetworkCaptured || []).length;
  window.__bridgeNetworkCaptured = [];
  return { cleared: count };
}

// ══════════════════════════════════════
// Canvas 文本 Hook — 拦截 canvas 渲染的文字（适用于用 canvas 绘制正文的页面）
// 通用能力：patch fillText/strokeText 收集绘制文本，再按坐标重排成可读文本
// ══════════════════════════════════════
function installResumeHook() {
  const frameUrl = window.location.href;
  if (window.__bossResumeCanvasHookInstalled)
    return { already: true, installed: false, frameUrl };
  window.__bossResumeCanvasHookInstalled = true;
  window.__bossResumeCanvasTexts = [];

  const origFill = CanvasRenderingContext2D.prototype.fillText;
  const origStroke = CanvasRenderingContext2D.prototype.strokeText;

  function record(kind, ctx, args) {
    try {
      const canvas = ctx && ctx.canvas;
      window.__bossResumeCanvasTexts.push({
        kind,
        text: String(args[0] || ''),
        x: Number(args[1] || 0),
        y: Number(args[2] || 0),
        font: String(ctx.font || ''),
        fillStyle: String(ctx.fillStyle || ''),
        strokeStyle: String(ctx.strokeStyle || ''),
        canvasId: (canvas && canvas.id) || '',
        canvasWidth: (canvas && canvas.width) || 0,
        canvasHeight: (canvas && canvas.height) || 0
      });
    } catch (e) {}
  }

  CanvasRenderingContext2D.prototype.fillText = function (...args) {
    record('fillText', this, args);
    return origFill.apply(this, args);
  };
  CanvasRenderingContext2D.prototype.strokeText = function (...args) {
    record('strokeText', this, args);
    return origStroke.apply(this, args);
  };

  return { installed: true, already: false, frameUrl };
}

// 同步读取：仅收集当前已拦截的 Canvas 文字 + DOM 文字
function readResumeCanvasSync() {
  const drawCalls = [...(window.__bossResumeCanvasTexts || [])];
  const dialog = document.querySelector('.dialog-wrap.active, .boss-dialog__wrapper.dialog-lib-resume, .dialog-wrap, .boss-dialog__wrapper');
  const domText = (dialog ? (dialog.innerText || dialog.textContent || '') : (document.body && document.body.innerText || '')).replace(/\s+/g, ' ').trim().substring(0, 8000);
  const canvasCount = (dialog || document).querySelectorAll('canvas').length;

  // 检查是否有 resume iframe
  const frames = Array.from((dialog || document).querySelectorAll('iframe')).map(f => ({
    src: f.getAttribute('src') || f.src || '',
    hasDoc: !!f.contentDocument,
    isResumeIframe: (f.src || '').includes('/web/frame/c-resume')
  }));

  return {
    drawCallsCount: drawCalls.length,
    canvasCount,
    domText,
    frames,
    hasResumeIframe: frames.some(f => f.isResumeIframe)
  };
}

// 异步完整读取：逐屏滚动简历弹窗，收集所有 Canvas 文字并重建文本
async function readResumeCanvasFull(maxScrolls) {
  const limit = maxScrolls || 15;

  // 查找简历弹窗
  const selectors = [
    '.dialog-wrap.active', '.boss-dialog__wrapper.dialog-lib-resume',
    '.dialog-wrap', '.boss-dialog__wrapper'
  ];
  let dialog = null;
  for (const sel of selectors) {
    dialog = document.querySelector(sel);
    if (dialog && dialog.offsetParent !== null) break;
  }

  if (!dialog) {
    // 检查是否在 iframe 中（Boss 的简历 iframe）
    const frames = Array.from(document.querySelectorAll('iframe'))
      .filter(f => (f.src || '').includes('/web/frame/c-resume'));
    return {
      ok: false,
      reason: 'resume likely in iframe',
      resumeFrames: frames.map(f => ({
        src: f.src || f.getAttribute('src') || '',
        hasDoc: !!f.contentDocument
      }))
    };
  }

  // 找可滚动容器
  const wrap = dialog.querySelector('.resume-detail-wrap, .lib-standard-resume') || dialog;
  const canvasCount = dialog.querySelectorAll('canvas').length;
  const domText = (dialog.innerText || '').replace(/\s+/g, ' ').trim();
  const clientH = wrap.clientHeight || 600;
  const totalH = wrap.scrollHeight || 2000;
  const steps = Math.min(limit, Math.ceil(totalH / Math.max(clientH, 1)));

  // 滚动收集
  const allCalls = [];
  const seen = new Set();
  for (let i = 0; i < steps; i++) {
    wrap.scrollTop = i * clientH;
    await new Promise(r => setTimeout(r, 350));
    const newCalls = window.__bossResumeCanvasTexts || [];
    for (const c of newCalls) {
      const key = c.text + '|' + Math.round(c.y) + '|' + Math.round(c.x);
      if (!seen.has(key)) {
        seen.add(key);
        allCalls.push(c);
      }
    }
  }

  // 按 Y 坐标分行重建文本
  const lineMap = {};
  for (const c of allCalls) {
    const lineKey = Math.round(c.y / 3) * 3; // 用 3px 容差分组
    if (!lineMap[lineKey]) lineMap[lineKey] = [];
    lineMap[lineKey].push(c);
  }
  const sorted = Object.entries(lineMap)
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const reconstructed = sorted
    .map(([, calls]) => {
      calls.sort((a, b) => a.x - b.x);
      return calls.map(c => c.text).join('');
    })
    .join('\n');

  return {
    ok: true,
    canvasCount,
    drawCalls: allCalls.length,
    steps,
    scrollHeight: totalH,
    domText: domText.substring(0, 3000),
    reconstructedText: reconstructed.substring(0, 20000)
  };
}

// ─── 标签页变化监听 — 自动推送页面信息到控制台 ───
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.title) return;
  const cgid = await getControlledGroupId();
  if (!cgid) return;
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.groupId !== cgid) return;
    pushPageInfo(t);
  } catch (e) {}
});

// 定期推送（每 30 秒），只读不切换标签页。
// 用 chrome.alarms 而非 setInterval —— alarms 在 SW 被回收后仍会按时唤醒 worker，
// setInterval 则会随 worker 一起消失。（alarms 最小周期约 30s）
chrome.alarms.create('pushPageInfo', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'pushPageInfo') return;
  if (!relayConnected || !relayBridgeUrl) return;
  try {
    const cgid = await getControlledGroupId();
    if (!cgid) return;
    const tabs = await chrome.tabs.query({ groupId: cgid });
    if (tabs.length > 0) pushPageInfo(tabs[0]);
  } catch (e) {}
});

async function pushPageInfo(tab) {
  if (!relayConnected || !relayBridgeUrl) return;
  try {
    let cookieCount = 0;
    try {
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      cookieCount = cookies.length;
    } catch (e) {}
    await fetch(`${relayBridgeUrl}/api/session-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (relayToken || '') },
      body: JSON.stringify({
        browserId: relayBrowserId,
        token: relayToken || undefined,
        pageInfo: {
          title: tab.title || '',
          url: tab.url || '',
          tabId: tab.id,
          favIconUrl: tab.favIconUrl || '',
          cookieCount,
          active: tab.active
        }
      }),
    });
    console.log('[Bridge] 📄 页面信息已推送:', tab.title, cookieCount, 'cookies');
  } catch (e) {
    console.error('[Bridge] 推送页面信息失败:', e.message);
  }
}

console.log('[Bridge] Background worker 已就绪 (Relay 模式, iframe + Canvas)');
