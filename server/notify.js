// ============================================================
//  通知模块 —— 钉钉群机器人 webhook（零依赖，Node 内置 https+crypto）
//  配置(环境变量)：
//    DINGTALK_WEBHOOK  完整 webhook URL，或只填 access_token
//    DINGTALK_SECRET   可选，机器人「加签」密钥（HMAC-SHA256）
//    DINGTALK_KEYWORD  可选，若机器人用「关键词」安全设置，会自动把关键词拼进消息
//  未配置时 notify() 静默返回 {sent:false}，不报错。
// ============================================================

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// 构造带签名的最终 URL（钉钉加签：sign = base64(HMAC-SHA256(secret, `${ts}\n${secret}`))）
function buildUrl() {
  let webhook = process.env.DINGTALK_WEBHOOK || '';
  if (!webhook) return null;
  if (!/^https?:\/\//.test(webhook)) {
    webhook = 'https://oapi.dingtalk.com/robot/send?access_token=' + webhook;
  }
  const secret = process.env.DINGTALK_SECRET || '';
  if (secret) {
    const ts = Date.now();
    const sign = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
    webhook += (webhook.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
  }
  return webhook;
}

function notify(textMsg, opts = {}) {
  return new Promise((resolve) => {
    const url = buildUrl();
    if (!url) return resolve({ sent: false, reason: 'DINGTALK_WEBHOOK 未配置' });

    let content = String(textMsg == null ? '' : textMsg);
    const keyword = process.env.DINGTALK_KEYWORD || '';
    if (keyword && !content.includes(keyword)) content = keyword + ' ' + content; // 关键词安全设置

    const payload = JSON.stringify({ msgtype: 'text', text: { content } });
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ sent: false, reason: 'invalid webhook url' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: opts.timeout || 10000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(body); } catch (e) {}
        const ok = res.statusCode === 200 && (j.errcode === 0 || j.errcode === undefined);
        resolve({ sent: ok, status: res.statusCode, resp: j });
      });
    });
    req.on('error', (e) => resolve({ sent: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ sent: false, reason: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

module.exports = { notify, buildUrl };
