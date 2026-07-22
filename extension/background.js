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

    // ── 直接导出已渲染的 canvas 为 PNG（绕开 hook 时序，适合静态/一次性绘制的 canvas）──
    // 位图挂在 DOM 元素上、跨 world 共享，所以能读到页面画好的像素；配合 frameId 读 iframe 内 canvas。
    case 'read_canvas_image': {
      return await executeInTab(tab.id, readCanvasImage, [params.selector || 'canvas', params.format || 'image/png', params.maxDim || 0], frameId, 'MAIN');
    }
    // 逐屏滚动导出（兜底虚拟化 canvas；静态长图会自动去重成 1 张）
    case 'read_canvas_full': {
      return await executeInTab(tab.id, readCanvasFull,
        [params.selector || 'canvas', params.container || '', params.maxScrolls || 20, params.delay || 350, params.maxDim || 0], frameId, 'MAIN');
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
    // 自动处理 JS 对话框
    case 'install_dialog_handler':
      return await executeInTab(tab.id, installDialogHandler, [params.opts || {}], frameId, 'MAIN');
    case 'get_dialogs':
      return await executeInTab(tab.id, getDialogs, [], frameId, 'MAIN');
    // 录制器（codegen）——隔离世界即可监听真实事件
    case 'install_recorder':
      return await executeInTab(tab.id, installRecorder, [], frameId);
    case 'get_recording':
      return await executeInTab(tab.id, getRecording, [], frameId);
    case 'stop_recorder':
      return await executeInTab(tab.id, stopRecorder, [], frameId);

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
      // 默认隔离世界（不受页面 CSP 影响，但读不到页面 JS 变量）；传 world:'MAIN' 可读页面变量/调页面函数，
      // 但此时 eval 会受页面 CSP 限制（禁 unsafe-eval 的页面会失败 → 返回 error）。
      return await executeInTab(tab.id, evalCode, [params.code], frameId, params.world === 'MAIN' ? 'MAIN' : undefined);
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

  // display:none / visibility:hidden → 整个子树跳过（不递归）；跨 frame 用元素自己文档的 view
  const isHidden = (el) => {
    const style = ((el.ownerDocument && el.ownerDocument.defaultView) || window).getComputedStyle(el);
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
    // 穿透同源 iframe（跨源 contentDocument 抛错→跳过）
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let fd = null; try { fd = el.contentDocument; } catch (e) {}
      if (fd && fd.body) walk(fd.body);
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

  const frameDoc = (el) => { if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null; try { return el.contentDocument; } catch (e) { return null; } };
  // 遍历元素，穿透开放 Shadow DOM 和同源 iframe（跨源 contentDocument 抛错→跳过）
  const deepEls = (root, acc) => {
    acc = acc || [];
    let list; try { list = root.querySelectorAll('*'); } catch (e) { return acc; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i]; acc.push(el);
      if (el.shadowRoot) deepEls(el.shadowRoot, acc);
      const fd = frameDoc(el); if (fd) deepEls(fd, acc);
    }
    return acc;
  };
  // 收集所有可查询的根（主文档 + 各 shadowRoot + 同源 iframe 文档），CSS 选择器逐根查询
  const deepRoots = () => {
    const roots = [document];
    for (const el of deepEls(document)) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      const fd = frameDoc(el); if (fd) roots.push(fd);
    }
    return roots;
  };
  const deepQueryAll = (sel) => {
    const out = [], seen = new Set();
    for (const r of deepRoots()) { try { r.querySelectorAll(sel).forEach(e => { if (!seen.has(e)) { seen.add(e); out.push(e); } }); } catch (e) {} }
    return out;
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
  // 跨 frame 安全：用元素自己文档的 view 计算样式
  const gcs = (el) => ((el.ownerDocument && el.ownerDocument.defaultView) || window).getComputedStyle(el);
  const nameOf = (el) => {
    const a = attr(el, 'aria-label'); if (a) return a.trim();
    const od = el.ownerDocument || document;
    if (el.id) { try { const lab = od.querySelector('label[for="' + ((window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id) + '"]'); if (lab) return txt(lab); } catch (e) {} }
    const wl = el.closest && el.closest('label'); if (wl) { const t = txt(wl); if (t) return t; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return attr(el, 'placeholder') || attr(el, 'name') || '';
    return txt(el) || attr(el, 'title') || '';
  };
  const matchStr = (val, want, exact) => { if (want == null) return true; val = (val || '').trim(); return exact ? val === want : val.indexOf(want) !== -1; };
  const visReason = (el) => {
    if (!el || !el.isConnected) return 'detached';
    const s = gcs(el);
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
    if (spec.within) { const c = deepQueryAll(spec.within)[0] || null; base = c ? base.filter(el => c.contains(el)) : []; }
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

// 自动处理 JS 对话框（alert/confirm/prompt），避免页面弹窗卡住自动化。
// opts: { accept=true, promptText='' }。会记录出现过的对话框到 window.__bridgeDialogs。
function installDialogHandler(opts) {
  opts = opts || {};
  const accept = opts.accept !== false;
  const promptText = opts.promptText != null ? opts.promptText : '';
  if (!window.__bridgeDialogs) window.__bridgeDialogs = [];
  window.__bridgeDialogAccept = accept;
  window.__bridgeDialogPromptText = promptText;
  if (window.__bridgeDialogHandlerInstalled) return { ok: true, already: true, accept, dialogs: window.__bridgeDialogs.length };
  window.__bridgeDialogHandlerInstalled = true;
  const rec = (type, message) => { try { window.__bridgeDialogs.push({ type, message: String(message == null ? '' : message).slice(0, 500), at: Date.now() }); } catch (e) {} };
  window.alert = function (m) { rec('alert', m); };
  window.confirm = function (m) { rec('confirm', m); return !!window.__bridgeDialogAccept; };
  window.prompt = function (m, d) { rec('prompt', m); return window.__bridgeDialogAccept ? (window.__bridgeDialogPromptText || (d || '')) : null; };
  try { window.onbeforeunload = null; } catch (e) {} // 尽力压制 beforeunload 原生弹窗（仅属性式 handler）
  return { ok: true, installed: true, accept };
}
function getDialogs() {
  const d = window.__bridgeDialogs || [];
  return { dialogs: d, count: d.length };
}

// ══════════════════════════════════════
// 录制器（codegen）——记录用户手动的点击/输入，供生成脚本
// 运行在隔离世界：内容脚本可监听页面真实事件，__bridgeRecorder 跨 executeScript 持久
// ══════════════════════════════════════
function installRecorder() {
  const rec = window.__bridgeRecorder = window.__bridgeRecorder || { steps: [], active: false, listeners: null };
  if (rec.active) return { ok: true, already: true, steps: rec.steps.length };
  rec.active = true;

  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
  const roleOf = (el) => {
    const e = el.getAttribute && el.getAttribute('role'); if (e) return e;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'; return 'textbox'; }
    if (tag === 'textarea') return 'textbox';
    return tag;
  };
  const nameOf = (el) => {
    const a = el.getAttribute && el.getAttribute('aria-label'); if (a) return a.trim();
    const wl = el.closest && el.closest('label'); if (wl && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { const t = txt(wl); if (t) return t; }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.getAttribute('placeholder') || '';
    return txt(el);
  };
  const cssPath = (el) => {
    if (el.id) return '#' + esc(el.id);
    const parts = []; let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && parts.length < 4) {
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
      let sel = cur.tagName.toLowerCase();
      const p = cur.parentElement;
      if (p) { const sibs = Array.from(p.children).filter(c => c.tagName === cur.tagName); if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')'; }
      parts.unshift(sel); cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const locatorFor = (el) => {
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
    if (testid) return { testid };
    if (el.id) return { css: '#' + esc(el.id) };
    const role = roleOf(el), name = nameOf(el);
    if (role && name && name.length <= 40) return { role, name };
    const t = txt(el);
    if ((el.tagName === 'A' || el.tagName === 'BUTTON' || role === 'button' || role === 'link') && t && t.length <= 40) return { text: t };
    return { css: cssPath(el) };
  };

  const onClick = (e) => {
    const el = e.target; if (!el || el.nodeType !== 1) return;
    const target = el.closest('a,button,input,select,textarea,[role],[onclick],label') || el;
    rec.steps.push({ type: 'click', locator: locatorFor(target), at: Date.now() });
  };
  const onChange = (e) => {
    const el = e.target; if (!el || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') rec.steps.push({ type: el.checked ? 'check' : 'uncheck', locator: locatorFor(el), at: Date.now() });
      else rec.steps.push({ type: 'fill', locator: locatorFor(el), value: String(el.value || '').slice(0, 500), at: Date.now() });
    } else if (tag === 'select') {
      rec.steps.push({ type: 'select', locator: locatorFor(el), value: el.value, at: Date.now() });
    }
  };
  rec.listeners = { onClick, onChange };
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  return { ok: true, installed: true };
}
function getRecording() { const r = window.__bridgeRecorder; return { steps: (r && r.steps) || [], active: !!(r && r.active) }; }
function stopRecorder() {
  const r = window.__bridgeRecorder;
  if (r && r.listeners) { try { document.removeEventListener('click', r.listeners.onClick, true); document.removeEventListener('change', r.listeners.onChange, true); } catch (e) {} r.active = false; }
  return { steps: (r && r.steps) || [], stopped: true };
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

// 直接把已渲染的 canvas 导出为图片（不依赖 hook，适合静态/一次性绘制的 canvas，再交给视觉模型 OCR）
// selector: 选哪些 canvas（默认全部）; format: image/png|image/jpeg; maxDim: 最长边缩放上限(0=不缩)
function readCanvasImage(selector, format, maxDim) {
  const list = Array.from(document.querySelectorAll(selector || 'canvas'));
  const fmt = format || 'image/png';
  const out = [];
  for (const c of list) {
    if (!(c instanceof HTMLCanvasElement)) continue;
    let dataUrl = null, error = null;
    try {
      if (maxDim && (c.width > maxDim || c.height > maxDim)) {
        const scale = maxDim / Math.max(c.width, c.height);
        const tmp = document.createElement('canvas');
        tmp.width = Math.max(1, Math.round(c.width * scale));
        tmp.height = Math.max(1, Math.round(c.height * scale));
        tmp.getContext('2d').drawImage(c, 0, 0, tmp.width, tmp.height);
        dataUrl = tmp.toDataURL(fmt);
      } else {
        dataUrl = c.toDataURL(fmt);
      }
    } catch (e) { error = e.message; } // 跨源污染的 canvas → SecurityError
    out.push({ id: c.id || '', className: c.className || '', width: c.width, height: c.height, dataUrl, error, bytes: dataUrl ? dataUrl.length : 0 });
  }
  return { count: out.length, url: location.href, canvases: out };
}

// 逐屏滚动导出 canvas 图片（兜底虚拟化 canvas：视口大小、滚动时重绘的那种）。
// 自动去重：静态长图每屏 toDataURL 相同 → 只保留 1 张；虚拟化的每屏不同 → 保留多张。
async function readCanvasFull(selector, containerSel, maxScrolls, delay, maxDim) {
  selector = selector || 'canvas';
  maxScrolls = maxScrolls || 20;
  delay = delay || 350;
  const pickCanvas = () => {
    const list = Array.from(document.querySelectorAll(selector)).filter(c => c instanceof HTMLCanvasElement);
    list.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return list[0] || null;
  };
  const exportCanvas = (c) => {
    try {
      if (maxDim && (c.width > maxDim || c.height > maxDim)) {
        const scale = maxDim / Math.max(c.width, c.height);
        const t = document.createElement('canvas');
        t.width = Math.max(1, Math.round(c.width * scale)); t.height = Math.max(1, Math.round(c.height * scale));
        t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
        return t.toDataURL('image/png');
      }
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  };
  // 从 canvas 往上找"真正能滚的那个祖先"（弹窗内的滚动区往往是它，而非 document）
  const findScrollContainer = (startEl) => {
    let el = startEl && startEl.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      try {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowY === 'overlay') && el.scrollHeight > el.clientHeight + 4) return el;
      } catch (e) {}
      el = el.parentElement;
    }
    return null;
  };
  let container = null;
  if (containerSel) { try { container = document.querySelector(containerSel); } catch (e) {} }
  if (!container) container = findScrollContainer(pickCanvas());
  if (!container) {
    container = document.querySelector('.resume-detail-wrap, .lib-standard-resume, .dialog-wrap [class*="scroll"], [class*="resume"] [class*="scroll"]')
      || document.scrollingElement || document.documentElement;
  }
  const clientH = container.clientHeight || window.innerHeight || 800;
  const firstCanvas = pickCanvas();
  const totalH = Math.max(container.scrollHeight || 0, (firstCanvas ? firstCanvas.height : 0), clientH);
  const steps = Math.min(maxScrolls, Math.max(1, Math.ceil(totalH / Math.max(clientH, 1))));

  const frames = [];
  const seen = new Set();
  for (let i = 0; i < steps; i++) {
    try { container.scrollTop = i * clientH; } catch (e) {}
    await new Promise(r => setTimeout(r, delay));
    const c = pickCanvas();
    if (!c) continue;
    const url = exportCanvas(c);
    if (!url) continue;
    const sig = url.length + '|' + url.slice(0, 96) + '|' + url.slice(url.length >> 1, (url.length >> 1) + 96) + '|' + url.slice(-96);
    if (seen.has(sig)) continue;
    seen.add(sig);
    frames.push({ index: frames.length, scrollTop: container.scrollTop, width: c.width, height: c.height, bytes: url.length, dataUrl: url });
  }
  try { container.scrollTop = 0; } catch (e) {}
  return { count: frames.length, steps, containerTag: (container.className || container.tagName || ''), canvasCount: document.querySelectorAll(selector).length, frames };
}

// ══════════════════════════════════════
// Canvas 文本 Hook — 拦截 canvas 渲染的文字（适用于用 canvas 绘制正文的页面）
// 通用能力：patch fillText/strokeText 收集绘制文本，再按坐标重排成可读文本
// ══════════════════════════════════════
// 提前把钩子装进"当前窗口 + 所有同源 iframe"，并用 MutationObserver 盯新出现的 iframe（如简历 c-resume）自动补装；
// 直接 patch 子窗口的 CanvasRenderingContext2D.prototype（不走 eval → 不受页面 CSP 限制）。
// 正确用法：**打开简历弹窗之前**先调它，观察器会赶在 canvas 绘制前把钩子装进新 iframe。
function installResumeHook() {
  const installHookInWindow = (win) => {
    try {
      if (!win) return false;
      if (win.__bossResumeCanvasHookInstalled) return true;
      const CRC = win.CanvasRenderingContext2D;
      if (!CRC || !CRC.prototype) return false;
      win.__bossResumeCanvasHookInstalled = true;
      win.__bossResumeCanvasTexts = win.__bossResumeCanvasTexts || [];
      const origFill = CRC.prototype.fillText;
      const origStroke = CRC.prototype.strokeText;
      const record = (kind, ctx, args) => {
        try {
          const canvas = ctx && ctx.canvas;
          win.__bossResumeCanvasTexts.push({
            kind, text: String(args[0] == null ? '' : args[0]),
            x: Number(args[1] || 0), y: Number(args[2] || 0),
            font: String(ctx.font || ''), fillStyle: String(ctx.fillStyle || ''), strokeStyle: String(ctx.strokeStyle || ''),
            canvasId: (canvas && canvas.id) || '', canvasWidth: (canvas && canvas.width) || 0, canvasHeight: (canvas && canvas.height) || 0,
            scrollTop: Number(win.__bossResumeScrollTop || 0), at: Date.now(),
          });
        } catch (e) {}
      };
      CRC.prototype.fillText = function (...a) { record('fillText', this, a); return origFill.apply(this, a); };
      CRC.prototype.strokeText = function (...a) { record('strokeText', this, a); return origStroke.apply(this, a); };
      // 探针：画一句测试文字，能记录到即说明钩子在工作
      win.__bossResumeCanvasHookProbe = function () {
        try { const c = win.document.createElement('canvas'); c.width = 1; c.height = 1; c.getContext('2d').fillText('Boss-TraceID test', 0, 0); return true; } catch (e) { return false; }
      };
      return true;
    } catch (e) { return false; }
  };
  const installTree = (win) => {
    let count = installHookInWindow(win) ? 1 : 0;
    try {
      const doc = win.document;
      Array.from(doc.querySelectorAll('iframe')).forEach((f) => { try { if (f.contentWindow) count += installTree(f.contentWindow); } catch (e) {} });
      if (!win.__bossResumeIframeHookObserverInstalled) {
        win.__bossResumeIframeHookObserverInstalled = true;
        const obs = new win.MutationObserver(() => {
          try { Array.from(doc.querySelectorAll('iframe')).forEach((f) => { try { if (f.contentWindow) installTree(f.contentWindow); } catch (e) {} }); } catch (e) {}
        });
        try { obs.observe(doc.documentElement || doc, { childList: true, subtree: true }); } catch (e) {}
      }
    } catch (e) {}
    return count;
  };
  const frames = installTree(window);
  let probeOk = false;
  try { probeOk = !!(window.__bossResumeCanvasHookProbe && window.__bossResumeCanvasHookProbe()); } catch (e) {}
  return { installed: true, frames, probeOk, frameUrl: location.href };
}

// 同步读取：收集所有同源窗口已拦截的 Canvas 文字，重建文本（不滚动）
function readResumeCanvasSync() {
  const reconstruct = (drawCalls, yTol) => {
    yTol = yTol || 3;
    // 按 canvasId 分组，选"绘制文字最密的那个 canvas"作为正文（隔离噪声/诱饵 canvas）；
    // 若存在 id=='resume' 且有实质内容则优先它。
    const byCanvas = {};
    for (const c of drawCalls) { if (!c) continue; const id = String(c.canvasId || ''); (byCanvas[id] = byCanvas[id] || []).push(c); }
    let best = drawCalls, bestN = -1;
    for (const id in byCanvas) { if (byCanvas[id].length > bestN) { bestN = byCanvas[id].length; best = byCanvas[id]; } }
    const src = (byCanvas['resume'] && byCanvas['resume'].length > 20) ? byCanvas['resume'] : best;
    const numeric = [];
    for (const c of src) {
      if (!c) continue;
      const text = String(c.text || '');
      if (!text.trim()) continue;
      if (text.indexOf('Boss-TraceID test') !== -1 || text.indexOf('bzl|abcdefghijklmnopqrstuvwxyz') === 0) continue;
      numeric.push({ text, x: Math.round((Number(c.x) || 0) * 10) / 10, y: Math.round((Number(c.y) || 0) * 10) / 10, scrollTop: Math.round((Number(c.scrollTop) || 0) * 10) / 10, canvasHeight: Math.round((Number(c.canvasHeight) || 0) * 10) / 10, font: String(c.font || '') });
    }
    const usesAbs = numeric.some((it) => it.canvasHeight > 0 && it.y > it.canvasHeight + 20);
    const seen = new Set(); const items = [];
    for (const it of numeric) {
      const absY = usesAbs ? it.y : Math.round((it.y + it.scrollTop) * 10) / 10;
      const key = it.text + '|' + it.x + '|' + absY + '|' + it.font;
      if (seen.has(key)) continue; seen.add(key);
      items.push({ text: it.text, x: it.x, y: absY });
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const groups = [];
    for (const it of items) {
      let placed = false;
      for (const g of groups) { const gy = g.reduce((s, v) => s + v.y, 0) / g.length; if (Math.abs(gy - it.y) <= yTol) { g.push(it); placed = true; break; } }
      if (!placed) groups.push([it]);
    }
    const lines = [];
    for (const g of groups) { g.sort((a, b) => a.x - b.x); const line = g.map((v) => v.text).join('').trim(); if (line) { const ay = g.reduce((s, v) => s + v.y, 0) / g.length; lines.push([ay, line]); } }
    lines.sort((a, b) => a[0] - b[0]);
    return lines.map((l) => l[1]).join('\n');
  };
  const wins = [window];
  document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentWindow) wins.push(f.contentWindow); } catch (e) {} });
  const allCalls = [];
  for (const w of wins) { try { const a = w.__bossResumeCanvasTexts; if (a && a.length) allCalls.push(...a); } catch (e) {} }
  const dialog = document.querySelector('.dialog-wrap.active, .boss-dialog__wrapper.dialog-lib-resume, .dialog-wrap, .boss-dialog__wrapper');
  const domText = (dialog ? (dialog.innerText || dialog.textContent || '') : (document.body && document.body.innerText || '')).replace(/\s+/g, ' ').trim().substring(0, 8000);
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => ({
    src: f.getAttribute('src') || f.src || '',
    hasDoc: (() => { try { return !!f.contentDocument; } catch (e) { return false; } })(),
    isResumeIframe: (f.src || '').includes('/web/frame/c-resume'),
  }));
  return {
    drawCallsCount: allCalls.length,
    reconstructedText: reconstruct(allCalls, 3).substring(0, 20000),
    canvasCount: (dialog || document).querySelectorAll('canvas').length,
    domText, frames, hasResumeIframe: frames.some((f) => f.isResumeIframe),
  };
}

// 异步完整读取：定位简历弹窗 + c-resume iframe，逐屏滚动触发重绘，从简历窗口收集绘制文字并重建
async function readResumeCanvasFull(maxScrolls) {
  const limit = maxScrolls || 15;
  const reconstruct = (drawCalls, yTol) => {
    yTol = yTol || 3;
    // 按 canvasId 分组，选"绘制文字最密的那个 canvas"作为正文（隔离噪声/诱饵 canvas）；
    // 若存在 id=='resume' 且有实质内容则优先它。
    const byCanvas = {};
    for (const c of drawCalls) { if (!c) continue; const id = String(c.canvasId || ''); (byCanvas[id] = byCanvas[id] || []).push(c); }
    let best = drawCalls, bestN = -1;
    for (const id in byCanvas) { if (byCanvas[id].length > bestN) { bestN = byCanvas[id].length; best = byCanvas[id]; } }
    const src = (byCanvas['resume'] && byCanvas['resume'].length > 20) ? byCanvas['resume'] : best;
    const numeric = [];
    for (const c of src) {
      if (!c) continue;
      const text = String(c.text || '');
      if (!text.trim()) continue;
      if (text.indexOf('Boss-TraceID test') !== -1 || text.indexOf('bzl|abcdefghijklmnopqrstuvwxyz') === 0) continue;
      numeric.push({ text, x: Math.round((Number(c.x) || 0) * 10) / 10, y: Math.round((Number(c.y) || 0) * 10) / 10, scrollTop: Math.round((Number(c.scrollTop) || 0) * 10) / 10, canvasHeight: Math.round((Number(c.canvasHeight) || 0) * 10) / 10, font: String(c.font || '') });
    }
    const usesAbs = numeric.some((it) => it.canvasHeight > 0 && it.y > it.canvasHeight + 20);
    const seen = new Set(); const items = [];
    for (const it of numeric) {
      const absY = usesAbs ? it.y : Math.round((it.y + it.scrollTop) * 10) / 10;
      const key = it.text + '|' + it.x + '|' + absY + '|' + it.font;
      if (seen.has(key)) continue; seen.add(key);
      items.push({ text: it.text, x: it.x, y: absY });
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const groups = [];
    for (const it of items) {
      let placed = false;
      for (const g of groups) { const gy = g.reduce((s, v) => s + v.y, 0) / g.length; if (Math.abs(gy - it.y) <= yTol) { g.push(it); placed = true; break; } }
      if (!placed) groups.push([it]);
    }
    const lines = [];
    for (const g of groups) { g.sort((a, b) => a.x - b.x); const line = g.map((v) => v.text).join('').trim(); if (line) { const ay = g.reduce((s, v) => s + v.y, 0) / g.length; lines.push([ay, line]); } }
    lines.sort((a, b) => a[0] - b[0]);
    return lines.map((l) => l[1]).join('\n');
  };
  const isVisible = (n) => { try { const s = n.ownerDocument.defaultView.getComputedStyle(n); const r = n.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; } catch (e) { return false; } };
  const txt = (n) => ((n && (n.innerText || n.textContent)) || '').replace(/\s+/g, ' ').trim();

  // 在主文档 + 同源 iframe 里找简历弹窗
  const docs = [document];
  document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} });
  let dialog = null, detailWrap = null, resumeWin = null;
  for (const doc of docs) {
    let dlgs = Array.from(doc.querySelectorAll('.dialog-wrap.active, .boss-dialog__wrapper.dialog-lib-resume')).filter(isVisible);
    if (!dlgs.length) dlgs = Array.from(doc.querySelectorAll('.dialog-wrap, .boss-dialog__wrapper')).filter(isVisible);
    for (const d of dlgs) {
      const dw = d.querySelector('.resume-detail-wrap, .lib-standard-resume');
      if (dw || /经历概览|工作经历|教育经历|期望|优势/.test(txt(d))) {
        dialog = d; detailWrap = dw || d;
        const rf = d.querySelector('iframe[src*="/web/frame/c-resume"]');
        if (rf) { try { resumeWin = rf.contentWindow; } catch (e) {} }
        break;
      }
    }
    if (detailWrap) break;
  }
  if (!detailWrap) {
    const rframes = [];
    document.querySelectorAll('iframe').forEach((f) => { if ((f.src || '').includes('/web/frame/c-resume')) rframes.push({ src: f.src || f.getAttribute('src') || '', hasDoc: (() => { try { return !!f.contentDocument; } catch (e) { return false; } })() }); });
    return { ok: false, reason: 'resume-detail-wrap not found', resumeFrames: rframes };
  }

  const clientH = detailWrap.clientHeight || 600;
  const totalH = Math.max(detailWrap.scrollHeight || 2000, clientH);
  const steps = Math.min(limit, Math.max(1, Math.ceil(totalH / Math.max(clientH, 1))));
  const allCalls = [];
  const collect = () => {
    const wins = [];
    if (resumeWin) wins.push(resumeWin);
    wins.push(window);
    document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentWindow) wins.push(f.contentWindow); } catch (e) {} });
    for (const w of wins) { try { const a = w.__bossResumeCanvasTexts; if (a && a.length) allCalls.push(...a.splice(0)); } catch (e) {} }
  };
  collect(); // 先收一次初始绘制（静态整张 canvas 的情况）
  for (let i = 0; i < steps; i++) {
    const top = i * clientH;
    if (resumeWin) { try { resumeWin.__bossResumeScrollTop = top; } catch (e) {} }
    try { window.__bossResumeScrollTop = top; } catch (e) {}
    try { detailWrap.scrollTop = top; } catch (e) {}
    try { detailWrap.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
    // 用 setTimeout 而非 requestAnimationFrame：后台/隐藏标签页的 rAF 会被暂停，会导致本函数永远卡住
    await new Promise((r) => setTimeout(r, 350));
    collect();
  }
  try { detailWrap.scrollTop = 0; } catch (e) {}
  return {
    ok: true,
    canvasCount: (dialog || document).querySelectorAll('canvas').length,
    drawCalls: allCalls.length,
    steps,
    scrollHeight: totalH,
    hasResumeFrame: !!resumeWin,
    domText: txt(dialog).substring(0, 3000),
    reconstructedText: reconstruct(allCalls, 3).substring(0, 20000),
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

// 页面信息推送是"可选遥测"（给控制台侧栏显示实时页面信息）。经 CodeNext 代理时，后台 service worker
// 的这条跨源请求可能被挡（Failed to fetch），但**不影响命令执行/简历读取**（那走的是控制台页上的中继）。
// 侧栏本来也靠 list_tabs 轮询兜底，所以这里失败只提示一次、不刷屏。
let __pushWarned = false;
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
    __pushWarned = false;
  } catch (e) {
    if (!__pushWarned) {
      __pushWarned = true;
      console.warn('[Bridge] 页面信息推送不可用（可忽略，不影响命令/简历读取）：' + e.message +
        ' —— 常见于经 CodeNext 代理时后台跨源请求被拦；控制台侧栏改用 list_tabs 轮询即可。');
    }
  }
}

console.log('[Bridge] Background worker 已就绪 (Relay 模式, iframe + Canvas)');
