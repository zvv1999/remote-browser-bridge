// ============================================================
//  快速上手示例（JS 脚本方式）
//  演示最常用的 Bridge API：连接 → 打开页面 → 等待 → 截图 → 提数据
//
//  用法:
//    node ../server/runner.js quickstart.js
//  或指定端口/token:
//    node ../server/runner.js quickstart.js --port=3006 --token=xxx
// ============================================================

exports.meta = {
  name: 'quickstart',
  description: '通用快速上手：打开页面、等待、截图、提取标题与链接',
  version: '1.0.0',
};

exports.main = async (bridge) => {
  const url = process.argv[3] || 'https://example.com';

  // 1. 复用已连接的浏览器（需先在扩展里连上控制台）
  console.log('🔗 连接浏览器...');
  await bridge.connect();

  // 2. 在受控标签组里新开一个标签打开目标页面
  console.log(`📌 打开 ${url}`);
  await bridge.newTab(url);

  // 3. 等待页面上出现某段文字（比固定 sleep 更稳）
  await bridge.waitForText('Example', 10000).catch(() => {});

  // 4. 截图（结果会显示在控制台的"截图"面板）
  console.log('📸 截图...');
  await bridge.screenshot();

  // 5. 读取页面信息
  const info = await bridge.getPageInfo(false); // 只要标题/URL，不回传 cookie 值
  console.log(`📄 标题: ${info.title}`);
  console.log(`🔗 URL : ${info.url}`);
  console.log(`📐 视口: ${info.viewport.width}x${info.viewport.height}`);

  // 6. 提取页面所有链接
  const links = await bridge.getLinks();
  console.log(`🔗 链接数: ${links.total}`);
  links.links.slice(0, 5).forEach((l, i) => console.log(`   ${i + 1}. ${l.text || '(无文字)'} → ${l.href}`));

  return { title: info.title, url: info.url, linkCount: links.total };
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
