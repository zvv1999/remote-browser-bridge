// ============================================================
//  结构化 ref 快照示例（对 LLM/Agent 友好）
//  演示：快照页面 → 拿到带编号的元素清单 → 按 ref 操作，无需 CSS 选择器
//
//  用法:
//    node ../server/runner.js ref-flow.js
//    node ../server/runner.js ref-flow.js https://duckduckgo.com
// ============================================================

exports.meta = {
  name: 'ref-flow',
  description: '结构化 ref 快照 + 按编号点击/输入',
  version: '1.0.0',
};

exports.main = async (bridge) => {
  const url = process.argv[3] || 'https://example.com';

  await bridge.connect();
  await bridge.newTab(url);
  await bridge.waitForText('', 3000).catch(() => {});
  await bridge.sleep(1000);

  // 1. 结构化快照：拿到带 [eN] 编号的元素清单
  const snap = await bridge.snapshotRefs(200);
  console.log(`\n🧭 结构化快照（${snap.count} 个元素${snap.truncated ? '，已截断' : ''}）:`);
  console.log(snap.text);

  // 2. 从 elements 里按角色/名字挑元素（这就是 LLM 会做的事）
  const firstTextbox = snap.elements.find(e => e.role === 'textbox' || e.role === 'searchbox');
  const firstLink = snap.elements.find(e => e.role === 'link');

  // 3. 演示：如果有输入框，输入一段文字；否则查看第一个链接
  if (firstTextbox) {
    console.log(`\n⌨️  向 ${firstTextbox.ref}（${firstTextbox.name || firstTextbox.placeholder || '输入框'}）输入文字...`);
    await bridge.typeRef(firstTextbox.ref, 'hello world');
    const info = await bridge.getRef(firstTextbox.ref);
    console.log(`   现在的值: ${JSON.stringify(info.value)}`);
  } else if (firstLink) {
    console.log(`\n🔎 查看第一个链接 ${firstLink.ref}:`);
    console.log('   ' + JSON.stringify(await bridge.getRef(firstLink.ref)));
  }

  return { url, elementCount: snap.count };
};

if (require.main === module) {
  const { Bridge } = require('../server/runner');
  const bridge = new Bridge({ port: process.env.BRIDGE_PORT || 3006 });
  exports.main(bridge).then(r => {
    console.log('\n✅ 完成:', JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
