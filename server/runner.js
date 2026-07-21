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

    const result = await this._httpPost('/api/command', body);
    this.results.push({ action, params, result, time: Date.now() });
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
