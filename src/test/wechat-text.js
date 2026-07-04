#!/usr/bin/env node
const { loadConfig } = require('../config');
const { WxbotAdapter } = require('../wechat/wxbotAdapter');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const wx = new WxbotAdapter(config);
  const health = await wx.checkHealth();
  console.log('wxbot health:', health);
  if (!health.ok) {
    console.error('wxbot 不可用，请先启动千帆中转机器人');
    process.exit(1);
  }
  const ts = new Date().toLocaleString('zh-CN');
  const result = await wx.sendText(`【钉钉助手测试】\n这是一条测试文字消息。\n时间：${ts}`);
  console.log('发送结果:', result);
  process.exit(0);
}

main().catch((err) => {
  logger.error('test:wechat-text 失败', { error: err.message });
  process.exit(1);
});
