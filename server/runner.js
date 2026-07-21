#!/usr/bin/env node
// ============================================================
//  Automation Runner — 通用浏览器自动化引擎
//  纯基础设施层，不包含任何业务逻辑
//  用户通过 JS 脚本或 JSON 步骤定义自己的自动化流程
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

// 鉴权 token 优先级：显式 opts.token > 环境变量 BRIDGE_TOKEN > 同目录 .bridge-token 文件
function loadToken(explicit) {
  if (explicit) return explicit;
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try { return fs.readFileSync(path.join(process.cwd(), '.bridge-token'), 'utf8').trim(); }
  catch (e) { return ''; }
}

// 把 trace 数组渲染成自包含的 HTML 时间线
function renderTraceHtml(trace) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = (trace || []).map((e) => {
    const cls = e.ok ? 'ok' : 'err';
    const shot = e.shot ? `<div class="shot"><img src="${e.shot}"></div>` : '';
    return `<div class="step ${cls}">
      <div class="head"><span class="seq">#${e.seq}</span><span class="act">${esc(e.action)}</span><span class="dur">${e.durationMs}ms</span><span class="badge ${cls}">${e.ok ? 'ok' : 'error'}</span></div>
      <div class="params">${esc(e.params)}</div>
      ${e.error ? `<div class="err-msg">${esc(e.error)}</div>` : ''}
      ${shot}
    </div>`;
  }).join('');
  const total = (trace || []).length;
  const failed = (trace || []).filter((e) => !e.ok).length;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Bridge Trace</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;background:#141a2e;color:#e0e0e0;margin:0;padding:20px}
  h1{font-size:18px;color:#7c8cf8;margin:0 0 4px}
  .sub{color:#8a93b8;font-size:12px;margin-bottom:16px}
  .step{background:#1b2647;border:1px solid #2a3566;border-left:4px solid #4caf50;border-radius:8px;padding:10px 12px;margin-bottom:8px}
  .step.err{border-left-color:#e57373}
  .head{display:flex;align-items:center;gap:10px;font-size:13px}
  .seq{color:#8a93b8;font-family:monospace}
  .act{font-weight:600;color:#cdd3f0}
  .dur{color:#8a93b8;font-size:11px;margin-left:auto}
  .badge{font-size:10px;padding:1px 8px;border-radius:10px}
  .badge.ok{background:rgba(76,175,80,.2);color:#81c784}
  .badge.err{background:rgba(244,67,54,.2);color:#e57373}
  .params{color:#9aa3c8;font-family:monospace;font-size:11px;margin-top:6px;word-break:break-all}
  .err-msg{color:#e57373;font-size:12px;margin-top:6px}
  .shot{margin-top:8px}
  .shot img{max-width:360px;border:1px solid #34407a;border-radius:6px}
</style></head><body>
<h1>Remote Browser Bridge — Trace</h1>
<div class="sub">${total} 步 · ${failed} 失败</div>
${rows || '<div class="sub">（无记录）</div>'}
</body></html>`;
}

class Bridge {
  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 3006;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.browserId = opts.browserId || null;
    this.token = loadToken(opts.token);
    this.vars = {};        // 用户变量存储
    this.results = [];     // 步骤执行记录
    this.verbose = opts.verbose !== false;
  }

  // ─── 底层 API 调用 ───
  async exec(action, params = {}, timeout = 30000) {
    const body = { action, params, timeout };
    if (this.browserId) body.browserId = this.browserId;

    if (this.verbose) process.stderr.write(`  ▶ ${action} ${JSON.stringify(params).substring(0, 60)}\n`);

    const start = Date.now();
    let result, err;
    try {
      result = await this._httpPost('/api/command', body);
      this.results.push({ action, params, result, time: Date.now() });
    } catch (e) { err = e; }
    // 追踪（tracing 时记录每步；screenshot 与 tracer 自身触发的调用不记，避免递归）
    if (this._tracing && !this._traceBusy && action !== 'screenshot') {
      await this._traceRecord(action, params, result, err, Date.now() - start);
    }
    if (err) throw err;
    return result;
  }

  // ─── 执行步骤序列 ───
  async execAll(steps) {
    const outcomes = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // 内置指令：print / set / if / loop / retry / sleep
      if (step.print !== undefined) {
        const msg = this._sub(step.print);
        console.log(msg);
        outcomes.push({ print: msg });
        continue;
      }
      if (step.set) {
        for (const [k, v] of Object.entries(step.set)) {
          this.vars[k] = this._sub(v);
        }
        continue;
      }
      if (step.sleep) {
        await this._sleep(typeof step.sleep === 'number' ? step.sleep : 1000);
        continue;
      }
      if (step.retry) {
        const r = await this._runRetry(step.retry);
        outcomes.push(r);
        continue;
      }
      if (step.if) {
        const r = await this._runIf(step.if);
        outcomes.push(r);
        continue;
      }
      if (step.loop) {
        const r = await this._runLoop(step.loop);
        outcomes.push(r);
        continue;
      }
      if (step.include) {
        const path = this._sub(step.include);
        const subSteps = require(path);
        const r = await this.execAll(Array.isArray(subSteps) ? subSteps : subSteps.steps);
        outcomes.push({ include: path, results: r });
        continue;
      }

      // 普通动作 → 调 bridge API
      const action = step.action;
      const params = this._subObj(step.params || {});
      const timeout = step.timeout || 30000;

      let result;
      try {
        result = await this.exec(action, params, timeout);
      } catch (e) {
        if (step.onError === 'continue') {
          result = { error: e.message };
        } else {
          throw e;
        }
      }

      // 存储结果
      if (step.store) {
        this.vars[step.store] = step.extract
          ? this._getPath(result, step.extract)
          : result;
      }
      // 总是存到 $prev
      this.vars['$prev'] = result;

      outcomes.push(result);
    }
    return outcomes;
  }

  // ─── 便捷方法 ───

  // ─── 连接到已有浏览器 ───
  async connect(browserIndex = 0) {
    const list = await this._httpGet('/api/browsers');
    if (!list.browsers || list.browsers.length === 0) {
      throw new Error('没有已连接的浏览器，请先打开控制台页面并连接扩展');
    }
    const entry = list.browsers[browserIndex] || list.browsers[0];
    this.browserId = entry.id;
    if (this.verbose) console.log(`✅ 复用连接: ${this.browserId}`);
    if (entry.pageInfo) {
      if (this.verbose) console.log(`   📄 ${entry.pageInfo.title || '?'}`);
    }
    return entry;
  }

  async browsers() {
    return this._httpGet('/api/browsers');
  }

  async waitForText(text, timeout = 15000) {
    // RPC 超时给到等待时长 + 余量，否则超过 30s 的等待会被服务器默认命令超时打断
    return this.exec('wait_for_text', { text, timeout }, timeout + 5000);
  }

  async waitForSelector(selector, timeout = 10000) {
    return this.exec('wait_for', { selector, timeout }, timeout + 5000);
  }

  async clickText(text) {
    return this.exec('click_text', { text });
  }

  async snapshot(maxLength = 8000) {
    return this.exec('snapshot', { maxLength });
  }

  // ── 结构化 ref 快照 + 按 ref 操作（对 LLM/Agent 友好，比 CSS 选择器稳）──
  // snapshotRefs() 返回 { text, elements:[{ref,role,name,...}] }，每个元素带 [eN] 编号；
  // 之后用 clickRef('e3') / typeRef('e5','文本') 直接按编号操作，无需选择器。
  async snapshotRefs(maxNodes = 200) {
    return this.exec('snapshot_refs', { maxNodes });
  }
  async clickRef(ref) {
    return this.exec('click_ref', { ref });
  }
  async typeRef(ref, text, clearFirst = true) {
    return this.exec('type_ref', { ref, text, clearFirst });
  }
  async getRef(ref) {
    return this.exec('get_ref', { ref });
  }

  // ── 定位器 + 自动等待（Playwright 式）──
  // spec: { css | ref | role+name | text | testid | label | placeholder, within, nth, hasText, exact }
  // 用法：await bridge.getByRole('button','登录').click()
  //       await bridge.getByLabel('用户名').fill('admin')
  //       await bridge.locator({ text:'结果' }).waitFor()
  locator(spec) {
    const self = this;
    const run = (op, args, opts) => {
      const t = (opts && opts.timeout) || 15000;
      return self.exec('locator_act', { spec, op, args: args || {}, opts: { timeout: t } }, t + 5000)
        .then((r) => { if (r && r.error) throw new Error(r.error); return r; });
    };
    const derive = (extra) => self.locator(Object.assign({}, spec, extra));
    return {
      spec,
      click: (opts) => run('click', {}, opts),
      dblclick: (opts) => run('dblclick', {}, opts),
      hover: (opts) => run('hover', {}, opts),
      fill: (text, opts) => run('fill', { text }, opts),
      type: (text, opts) => run('type', { text }, opts),
      check: (opts) => run('check', {}, opts),
      uncheck: (opts) => run('uncheck', {}, opts),
      selectOption: (value, opts) => run('selectOption', { value }, opts),
      press: (key, opts) => run('press', { key }, opts),
      scrollIntoView: (opts) => run('scrollIntoView', {}, opts),
      waitFor: (opts) => run('waitFor', { state: (opts && opts.state) || 'visible' }, opts),
      getText: (opts) => run('getText', {}, opts).then((r) => r && r.text),
      getValue: (opts) => run('getValue', {}, opts).then((r) => r && r.value),
      getAttribute: (name, opts) => run('getAttribute', { name }, opts).then((r) => r && r.value),
      // isVisible/count 不等待（0 也是有效答案）
      isVisible: () => self.exec('locator_act', { spec, op: 'isVisible', opts: { timeout: 1000 } }, 6000).then((r) => !!(r && r.visible)),
      count: () => self.exec('locator_act', { spec, op: 'count', opts: { timeout: 1000 } }, 6000).then((r) => (r && r.count) || 0),
      nth: (n) => derive({ nth: n }),
      first: () => derive({ nth: 0 }),
      last: () => derive({ nth: -1 }),
      withText: (t) => derive({ hasText: t }),
      within: (css) => derive({ within: css }),
    };
  }
  getByRole(role, name) { return this.locator(name != null ? { role, name } : { role }); }
  getByText(text, exact) { return this.locator({ text, exact: !!exact }); }
  getByLabel(label, exact) { return this.locator({ label, exact: !!exact }); }
  getByPlaceholder(placeholder, exact) { return this.locator({ placeholder, exact: !!exact }); }
  getByTestId(testid) { return this.locator({ testid }); }

  // ── 网络控制（等待空闲 / mock / abort，作用于 fetch）──
  // 等待连续 idleMs 内在途请求为 0（SPA 跳转/异步加载后用）
  async waitForNetworkIdle(opts = {}) {
    const timeout = opts.timeout || 15000;
    return this.exec('wait_network_idle', { idleMs: opts.idleMs || 500, timeout }, timeout + 5000);
  }
  // 路由匹配 fetch：action='abort' 让请求失败；或 {status,body,contentType,method,regex} 直接 mock 响应
  async route(urlPattern, action) {
    let route;
    if (action === 'abort') {
      route = { pat: urlPattern, kind: 'abort' };
    } else {
      action = action || {};
      let body = action.body;
      if (body != null && typeof body !== 'string') body = JSON.stringify(body);
      route = {
        pat: urlPattern, kind: 'fulfill',
        status: action.status || 200,
        body: body != null ? body : '',
        contentType: action.contentType || 'application/json',
        method: action.method, isRegex: !!action.regex,
      };
    }
    return this.exec('route_add', { route });
  }
  async clearRoutes() { return this.exec('route_clear'); }

  // ── Web-first 断言（自动重试到超时，Playwright 式 expect）──
  // 用法：await bridge.expect(bridge.getByText('结果')).toBeVisible()
  expect(locator) {
    const self = this;
    const spec = (locator && locator.spec) ? locator.spec : locator;
    const run = (op, args, opts) => {
      const t = (opts && opts.timeout) || 5000;
      return self.exec('locator_act', { spec, op, args: args || {}, opts: { timeout: t } }, t + 5000)
        .then((r) => { if (r && r.error) throw new Error(r.error); return r; });
    };
    return {
      toBeVisible: (o) => run('expectVisible', {}, o),
      toBeHidden: (o) => run('expectHidden', {}, o),
      toHaveText: (text, o) => run('expectText', { text }, o),
      toContainText: (text, o) => run('expectContainText', { text }, o),
      toHaveValue: (value, o) => run('expectValue', { value }, o),
      toBeChecked: (o) => run('expectChecked', { checked: true }, o),
      notToBeChecked: (o) => run('expectChecked', { checked: false }, o),
    };
  }

  // ── 对话框自动处理 ──
  // 提前安装：之后页面的 alert/confirm/prompt 自动响应，不再卡住自动化
  async handleDialogs(opts = {}) { return this.exec('install_dialog_handler', { opts }); }
  async getDialogs() { return this.exec('get_dialogs'); }

  // ── 轻量 trace（记录每步 + 可选截图 → 存成 HTML 时间线）──
  startTrace(opts = {}) {
    this._trace = [];
    this._tracing = true;
    this._traceBusy = false;
    this._traceOpts = { screenshots: !!opts.screenshots };
    return this;
  }
  stopTrace() { this._tracing = false; return this._trace || []; }
  async _traceRecord(action, params, result, err, durationMs) {
    const entry = {
      seq: (this._trace.length + 1), action,
      params: JSON.stringify(params || {}).slice(0, 300),
      ok: !err && !(result && result.error),
      error: err ? err.message : (result && result.error) || null,
      durationMs, at: Date.now(),
    };
    const visual = ['navigate', 'new_tab', 'reload', 'go_back', 'go_forward', 'click', 'type', 'click_text',
      'press_key', 'click_ref', 'type_ref', 'locator_act', 'scroll', 'scroll_to_bottom', 'dismiss_overlays'].includes(action);
    if (this._traceOpts.screenshots && visual) {
      this._traceBusy = true;
      try { const s = await this.exec('screenshot'); if (s && s.dataUrl) entry.shot = s.dataUrl; } catch (e) {}
      this._traceBusy = false;
    }
    this._trace.push(entry);
  }
  async saveTrace(filePath) {
    const trace = this._trace || [];
    fs.writeFileSync(filePath, renderTraceHtml(trace), 'utf8');
    return { path: filePath, steps: trace.length };
  }

  // ── Codegen：录制你的手动操作 → 生成脚本 ──
  async startRecording() { return this.exec('install_recorder'); }
  async getRecording() { return this.exec('get_recording'); }
  async stopRecording() { return this.exec('stop_recorder'); }
  // 把录制的步骤转成一段 runner 脚本源码
  generateScript(steps) {
    const q = (s) => JSON.stringify(String(s == null ? '' : s));
    const loc = (l) => {
      if (!l) return 'bridge.locator({})';
      if (l.testid) return `bridge.getByTestId(${q(l.testid)})`;
      if (l.role && l.name) return `bridge.getByRole(${q(l.role)}, ${q(l.name)})`;
      if (l.role) return `bridge.getByRole(${q(l.role)})`;
      if (l.text) return `bridge.getByText(${q(l.text)})`;
      if (l.css) return `bridge.locator({ css: ${q(l.css)} })`;
      return 'bridge.locator({})';
    };
    const lines = (steps || []).map((s) => {
      const L = loc(s.locator);
      if (s.type === 'click') return `  await ${L}.click();`;
      if (s.type === 'fill') return `  await ${L}.fill(${q(s.value)});`;
      if (s.type === 'check') return `  await ${L}.check();`;
      if (s.type === 'uncheck') return `  await ${L}.uncheck();`;
      if (s.type === 'select') return `  await ${L}.selectOption(${q(s.value)});`;
      return `  // (未知步骤: ${s.type})`;
    });
    return [
      '// 由 Remote Browser Bridge codegen 自动生成 —— 按需清理 / 参数化',
      'exports.main = async (bridge) => {',
      '  await bridge.connect();',
      ...lines,
      '  return { ok: true };',
      '};',
      '',
      'if (require.main === module) {',
      "  const { Bridge } = require('../server/runner');",
      '  const bridge = new Bridge({ port: process.env.BRIDGE_PORT || 3006 });',
      "  exports.main(bridge).then(() => console.log('✅ done')).catch(e => { console.error('❌', e.message); process.exit(1); });",
      '}',
      '',
    ].join('\n');
  }
  async saveScript(filePath, steps) {
    if (!steps) { const r = await this.getRecording(); steps = r.steps; }
    const code = this.generateScript(steps);
    fs.writeFileSync(filePath, code, 'utf8');
    return { path: filePath, steps: (steps || []).length };
  }

  async screenshot() {
    return this.exec('screenshot');
  }

  async navigate(url) {
    return this.exec('navigate', { url });
  }

  async newTab(url) {
    return this.exec('new_tab', { url });
  }

  async getPageInfo(includeCookies = true) {
    return this.exec('get_page_info', { includeCookies });
  }

  async getCookies(url) {
    return this.exec('get_cookies', url ? { url } : {});
  }

  async evaluate(code) {
    return this.exec('evaluate', { code });
  }

  // ── 基础 DOM 操作 ──
  async type(selector, text, clearFirst = true) {
    return this.exec('type', { selector, text, clearFirst });
  }

  async click(selector, index = 0) {
    return this.exec('click', { selector, index });
  }

  async pressKey(selector, key) {
    return this.exec('press_key', { selector, key });
  }

  async scroll(x = 0, y = 300) {
    return this.exec('scroll', { x, y });
  }

  async scrollIntoView(selector) {
    return this.exec('scroll_into_view', { selector });
  }

  async getText(selector) {
    return this.exec('get_text', { selector });
  }

  async getAttribute(selector, attribute) {
    return this.exec('get_attribute', { selector, attribute });
  }

  async getHtml(selector = 'body', maxLength = 10000) {
    return this.exec('get_html', { selector, maxLength });
  }

  async select(selector, value) {
    return this.exec('select', { selector, value });
  }

  // ── 页面辅助 ──
  async reload() {
    return this.exec('reload');
  }

  async goBack() {
    return this.exec('go_back');
  }

  async goForward() {
    return this.exec('go_forward');
  }

  async scrollToBottom(maxRounds = 5, delay = 600) {
    return this.exec('scroll_to_bottom', { maxRounds, delay });
  }

  async getLinks() {
    return this.exec('get_links');
  }

  async checkRisk() {
    return this.exec('check_risk');
  }

  // ── 人机协作：钉钉通知 + 人工接管 ──

  // 给你的钉钉推一条消息（需配置 DINGTALK_WEBHOOK，未配置则静默返回）
  async notify(text) {
    const { notify } = require('./notify');
    return notify(text);
  }

  // 暂停并等待你在控制台点「继续」；默认同时推一条钉钉通知。
  // opts: { timeout=300000, pollInterval=1500, notify=true }
  async waitForHuman(message, opts = {}) {
    const timeout = opts.timeout || 300000; // 默认最多等 5 分钟
    const pollInterval = opts.pollInterval || 1500;
    const created = await this._httpPost('/api/handoff/create', { message, timeoutMs: timeout });
    const id = created && created.id;
    if (opts.notify !== false) {
      try { await this.notify('⏸ 需要人工接管：' + message); } catch (e) {}
    }
    if (this.verbose) process.stderr.write(`  ⏸ 等待人工接管: ${message}\n`);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this._sleep(pollInterval);
      let st;
      try { st = await this._httpGet('/api/handoff/status?id=' + id); } catch (e) { continue; }
      if (st && st.status === 'resolved') {
        if (st.action === 'cancel') throw new Error('用户中止了操作 (human canceled)');
        if (this.verbose) process.stderr.write('  ▶ 人工已确认继续\n');
        return { resolved: true, action: st.action || 'continue' };
      }
      if (st && (st.status === 'expired' || st.status === 'unknown')) break;
    }
    throw new Error(`等待人工接管超时 (${timeout}ms)`);
  }

  // 检测风控/验证，命中则暂停等待人工处理（内部用 check_risk + waitForHuman）
  async pauseIfRisky(opts = {}) {
    const risk = await this.checkRisk();
    if (risk && risk.risky) {
      const msg = opts.message ||
        ('检测到风控/验证' + ((risk.markers && risk.markers.length) ? '：' + risk.markers.join('、') : '') + '，请手动处理后点「继续」');
      await this.waitForHuman(msg, opts);
      return { paused: true, risk };
    }
    return { paused: false, risk };
  }

  async dismissOverlays(maxAttempts = 12) {
    return this.exec('dismiss_overlays', { maxAttempts });
  }

  // ── 网络层 ──
  async networkIntercept() {
    return this.exec('network_intercept');
  }

  async networkRequests() {
    return this.exec('network_requests');
  }

  async networkFetch(url, method = 'GET', headers = {}, body = null) {
    return this.exec('network_fetch', { url, method, headers, body });
  }

  async networkClear() {
    return this.exec('network_clear');
  }

  // ── iframe ──
  async listFrames() {
    return this.exec('list_frames');
  }

  // ── Canvas 简历 ──
  async installResumeHook() {
    return this.exec('install_resume_hook');
  }

  async readResumeCanvas(frameId) {
    return this.exec('read_resume_canvas', frameId ? { frameId } : {});
  }

  async readResumeCanvasFull(maxScrolls = 15, frameId) {
    return this.exec('read_resume_canvas_full', { maxScrolls, ...(frameId ? { frameId } : {}) });
  }

  // ── 标签页管理 ──
  async closeTab(tabId) {
    return this.exec('close_tab', tabId ? { tabId } : {});
  }

  async listTabs() {
    return this.exec('list_tabs');
  }

  async switchTab(tabId) {
    return this.exec('switch_tab', { tabId });
  }

  // 设为当前目标标签但不激活（后台操控）
  async setTarget(tabId) {
    return this.exec('set_target', { tabId });
  }

  async getTarget() {
    return this.exec('get_target');
  }

  async createGroup() {
    return this.exec('create_group');
  }

  async listControlledTabs() {
    return this.exec('list_controlled_tabs');
  }

  async addToGroup(tabId) {
    return this.exec('add_to_group', { tabId });
  }

  async checkGroup() {
    return this.exec('check_group');
  }

  // ─── 判断条件 ───
  async waitUntil(checkFn, { timeout = 30000, interval = 1000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await checkFn(this);
      if (ok) return true;
      await this._sleep(interval);
    }
    return false;
  }

  // ─── 内部方法 ───

  _sub(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const val = this._getPath(this.vars, path);
      return val !== undefined ? String(val) : `{{${path}}}`;
    });
  }

  _subObj(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' ? this._sub(v)
        : typeof v === 'object' ? this._subObj(v)
        : v;
    }
    return out;
  }

  _getPath(obj, path) {
    if (obj === undefined || obj === null) return undefined;
    if (typeof path !== 'string') return obj;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  async _runIf(cond) {
    const test = this._evalCond(cond.cond);
    if (test) {
      return cond.then ? this.execAll(cond.then) : null;
    } else {
      return cond.else ? this.execAll(cond.else) : null;
    }
  }

  async _runLoop(opts) {
    const results = [];
    const overPath = typeof opts.over === 'string' ? this._sub(opts.over) : opts.over;
    const list = this._getPath(this.vars, overPath);
    if (!Array.isArray(list)) {
      console.error(`loop: variable "${opts.over}" is not an array`);
      return results;
    }
    const max = opts.max || list.length;
    const steps = opts.steps || [];
    for (let i = 0; i < Math.min(list.length, max); i++) {
      this.vars[opts.as || 'item'] = list[i];
      this.vars['$index'] = i;
      const r = await this.execAll(steps);
      results.push(r);
      if (opts.breakIf && this._evalCond(opts.breakIf)) break;
    }
    return results;
  }

  async _runRetry(opts) {
    const times = opts.times || 3;
    const delay = opts.delay || 1000;
    const steps = opts.steps || [];
    let lastErr;
    for (let i = 0; i < times; i++) {
      try {
        return await this.execAll(steps);
      } catch (e) {
        lastErr = e;
        if (i < times - 1) {
          if (this.verbose) process.stderr.write(`  ↻ retry ${i + 1}/${times} (${e.message})\n`);
          await this._sleep(delay);
        }
      }
    }
    throw lastErr;
  }

  _evalCond(expr) {
    if (typeof expr === 'boolean') return expr;
    if (typeof expr !== 'string') return !!expr;
    // 支持简单比较: {{var}} > 5, {{var}} == "text", {{var}}
    const subbed = this._sub(expr);
    // 尝试布尔比较
    const cmp = subbed.match(/^(.+?)\s*(==|!=|>=|<=|>|<|includes)\s*(.+)$/);
    if (cmp) {
      const [, left, op, right] = cmp;
      const l = this._tryParse(left.trim());
      const r = this._tryParse(right.trim().replace(/^["']|["']$/g, ''));
      switch (op) {
        case '==': return l == r;
        case '!=': return l != r;
        case '>=': return Number(l) >= Number(r);
        case '<=': return Number(l) <= Number(r);
        case '>': return Number(l) > Number(r);
        case '<': return Number(l) < Number(r);
        case 'includes': return String(l).includes(String(r));
      }
    }
    // 直接判断 truthy
    return !!this._tryParse(subbed);
  }

  _tryParse(s) {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === 'undefined') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  _httpPost(path, body) {
    return this._httpReq('POST', path, body);
  }

  _httpGet(path) {
    return this._httpReq('GET', path);
  }

  _httpReq(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      // socket 超时必须大于命令自身超时，否则 wait_for_text 这类长等待命令会被 socket 先掐断
      const cmdTimeout = (body && typeof body.timeout === 'number') ? body.timeout : 30000;
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: Math.max(65000, cmdTimeout + 15000),
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ok !== false) resolve(json.data !== undefined ? json.data : json);
            else reject(new Error(json.error || 'unknown error'));
          } catch (e) {
            reject(new Error(`Parse error: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

// ─── CLI 入口 ───
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node runner.js <脚本文件> [--port=3006] [--token=xxx] [--quiet]');
    console.log('  token 默认从 BRIDGE_TOKEN 环境变量或同目录 .bridge-token 文件自动读取');
    console.log('');
    console.log('脚本可以是:');
    console.log('  .json 文件 — JSON 步骤定义');
    console.log('  .js 文件   — JS 脚本 (可直接使用 Bridge API)');
    process.exit(1);
  }

  const scriptPath = path.resolve(args[0]);
  const opts = {};
  if (process.env.BRIDGE_PORT) opts.port = parseInt(process.env.BRIDGE_PORT, 10);
  for (const a of args.slice(1)) {
    if (a.startsWith('--port=')) opts.port = parseInt(a.split('=')[1]);
    if (a.startsWith('--token=')) opts.token = a.split('=')[1];
    if (a === '--quiet') opts.verbose = false;
  }

  (async () => {
    const bridge = new Bridge(opts);

    if (scriptPath.endsWith('.json')) {
      const steps = require(scriptPath);
      const list = Array.isArray(steps) ? steps : steps.steps;
      await bridge.connect();
      const results = await bridge.execAll(list);
      console.log(JSON.stringify(results, null, 2));
    } else if (scriptPath.endsWith('.js')) {
      // 用户 JS 脚本
      const userScript = require(scriptPath);
      if (typeof userScript === 'function') {
        await userScript(bridge);
      } else if (userScript.main) {
        await userScript.main(bridge);
      } else if (userScript.steps) {
        await bridge.connect();
        await bridge.execAll(userScript.steps);
      }
    } else {
      console.error('脚本文件必须是 .json 或 .js');
      process.exit(1);
    }
  })().catch(e => {
    console.error('❌', e.message);
    process.exit(1);
  });
}

module.exports = { Bridge };
