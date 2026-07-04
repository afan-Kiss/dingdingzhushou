#!/usr/bin/env node
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { takeScreenshot } = require('../adb/screenshot');
const { WxbotAdapter } = require('../wechat/wxbotAdapter');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);
  const check = await adb.checkDevice();
  if (!check.ok) {
    console.error('ADB 设备不可用:', check.reason, check.suggestion);
    process.exit(1);
  }

  const shot = await takeScreenshot(adb, 'test', 'manual');
  console.log('截图结果:', shot);

  if (process.argv.includes('--send-wechat') && shot.ok) {
    const wx = new WxbotAdapter(config);
    await wx.sendImage(shot.localPath);
    console.log('已发送微信图片');
  }

  process.exit(shot.ok ? 0 : 1);
}

main().catch((err) => {
  logger.error('test:screenshot 失败', { error: err.message });
  process.exit(1);
});
