// ============================================================
//  人工接管示例
//  打开页面 → 需要真人时暂停(控制台弹横幅 + 钉钉通知) → 你点「继续」后接着跑
//
//  用法:
//    node ../server/runner.js handoff.js
//    node ../server/runner.js handoff.js https://example.com
//
//  想收到钉钉通知，先设环境变量再启动 runner：
//    export DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=xxx"
//    export DINGTALK_SECRET="加签密钥(可选)"
// ============================================================

exports.meta = { name: 'handoff', description: '人工接管 + 钉钉通知演示', version: '1.0.0' };

exports.main = async (bridge) => {
  const url = process.argv[3] || 'https://example.com';

  await bridge.connect();
  await bridge.newTab(url);
  await bridge.sleep(2000);

  // 方式一：检测到风控/验证码时才暂停（命中会自动推钉钉 + 控制台横幅）
  const guard = await bridge.pauseIfRisky();
  if (guard.paused) console.log('✅ 人工已处理风控，继续');

  // 方式二：无条件请人工做某事（例如手动登录），阻塞直到你在控制台点「继续」
  // await bridge.waitForHuman('请在浏览器里登录后点「继续」', { timeout: 300000 });

  const info = await bridge.getPageInfo(false);
  console.log(`📄 当前页面: ${info.title}  ${info.url}`);

  // 任务结束也可以主动推一条钉钉
  await bridge.notify('✅ handoff 示例执行完成: ' + info.title);

  return { title: info.title, url: info.url, paused: guard.paused };
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
