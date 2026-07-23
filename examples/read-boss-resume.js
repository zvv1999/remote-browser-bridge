#!/usr/bin/env node
// ============================================================
//  稳定工具示例：读取当前已打开的 Boss 在线简历 → 结构化 JSON
//  纯程序驱动，不经 agent。底层用 CDP 可信滚动（完整、零 OCR）。
//
//  用法：
//    1) 仓库根目录启动 bridge：  npm start
//    2) 浏览器里打开某候选人的「在线简历」弹窗
//    3) 读当前简历：            node examples/read-boss-resume.js
//       顺便点开"查看全部"：     node examples/read-boss-resume.js --expand
//       只要结构化字段：          node examples/read-boss-resume.js --fields
//
//  环境变量：BRIDGE_PORT（默认 3006）、BRIDGE_TOKEN（默认自动读 .bridge-token）
//
//  作为库调用（自定义业务流程时）：
//    const { Bridge } = require('./server/runner');
//    const bridge = new Bridge({ port: 3006 });
//    await bridge.connect();
//    const { text, fields } = await bridge.readBossResume();   // ← 一行拿到简历
// ============================================================
const { Bridge } = require('../server/runner');

(async () => {
  const args = process.argv.slice(2);
  const expandAll = args.includes('--expand');
  const fieldsOnly = args.includes('--fields');

  const bridge = new Bridge({ port: process.env.BRIDGE_PORT ? parseInt(process.env.BRIDGE_PORT, 10) : 3006 });
  await bridge.connect();
  console.error('[read-boss-resume] 已连接，读取当前在线简历…' + (expandAll ? '（含展开"查看全部"）' : ''));

  const t0 = Date.now();
  const res = await bridge.readBossResume({ expandAll, maxSteps: 40 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[read-boss-resume] 完成：${secs}s · ${res.meta.chars} 字 · ${res.meta.drawCalls} draws · 展开点击 ${res.meta.expandClicks}`);
  if (!res.text) {
    console.error('⚠️  没读到内容。请确认：① 候选人「在线简历」弹窗已打开；② 扩展 ≥1.16.14 且已授予 debugger 权限。');
    process.exit(2);
  }
  if (res.fields.hasTruncation && !expandAll) {
    console.error('ℹ️  检测到"查看全部"截断内容未展开，可加 --expand 重读拿全。');
  }

  // 输出到 stdout（可 > 文件 或 | jq）
  const out = fieldsOnly ? res.fields : { fields: res.fields, meta: res.meta, text: res.text };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
