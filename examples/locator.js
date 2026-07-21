// ============================================================
//  定位器 + 自动等待示例（Playwright 式手感）
//  动作前自动等元素出现→可见→可用，免去手写 sleep / wait_for
//
//  用法: node ../server/runner.js locator.js https://example.com
// ============================================================

exports.meta = { name: 'locator', description: '定位器 + 自动等待演示', version: '1.0.0' };

exports.main = async (bridge) => {
  const url = process.argv[3] || 'https://example.com';

  await bridge.connect();
  await bridge.newTab(url);

  // 自动等待：不用手写 sleep，动作前自动等元素就绪
  // 按可见文字点第一个链接（interactive 优先、最短文本优先）
  const firstLink = bridge.getByRole('link').first();
  if (await firstLink.count()) {
    const text = await firstLink.getText();
    console.log(`🔗 第一个链接: ${text}`);
  }

  // 常见写法示例（按你的目标页面替换）：
  //   await bridge.getByLabel('用户名').fill('admin');
  //   await bridge.getByPlaceholder('搜索').fill('关键词');
  //   await bridge.getByRole('button', '登录').click();     // 自动等按钮可点
  //   await bridge.getByText('结果').waitFor();              // 等文字出现
  //   await bridge.locator({ css: '.item' }).nth(2).click(); // 第 3 个
  //   await bridge.locator({ testid: 'submit' }).click();

  const h1 = bridge.locator({ css: 'h1' });
  const title = (await h1.count()) ? await h1.getText() : '(无 h1)';
  console.log(`📄 H1: ${title}`);

  return { url, h1: title };
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
